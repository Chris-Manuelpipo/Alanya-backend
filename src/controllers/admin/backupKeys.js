const crypto = require('crypto');
const pool = require('../../config/db');
const {
  PLACEHOLDER_SECRET,
  KEY_BYTES,
} = require('../../services/backupKeyService');

/**
 * Administration des versions de clé de sauvegarde.
 *
 * ── Ce que la rotation résout ──
 *
 * Un secret finit toujours par devoir être remplacé : fuite, changement
 * d'hébergeur, simple hygiène. Avec un secret unique, ce remplacement rendrait
 * illisibles d'un coup TOUTES les sauvegardes déjà déposées — y compris celles
 * d'inscrits qui n'ouvriront l'application que dans six mois. D'où le `kid` :
 * chaque archive porte en clair, dans son en-tête, le numéro de la version qui
 * l'a chiffrée. On écrit avec la plus récente, on relit avec celle qu'il faut.
 *
 * Le mécanisme existait depuis la migration 078. Ce qui manquait, c'est de
 * pouvoir s'en servir autrement qu'en écrivant du SQL à la main — c'est-à-dire
 * au moment le plus délicat, sous pression, sans filet.
 *
 * ── Trois règles que ce fichier fait respecter ──
 *
 * 1. **Le secret ne sort jamais.** Aucune réponse ne le contient, sous aucune
 *    forme. Il est engendré ici et n'a aucune raison de voyager.
 * 2. **On ne supprime jamais une version.** Retirer l'écarte des nouvelles
 *    sauvegardes ; supprimer rendrait définitivement illisibles toutes celles
 *    qui la portent. Aucune route ne l'autorise, et c'est délibéré.
 * 3. **Il reste toujours une version active.** Sans elle, plus aucune
 *    sauvegarde ne peut être écrite — la panne serait silencieuse côté
 *    inscrit, qui verrait seulement des sauvegardes qui échouent.
 */

/** Ce qu'on rend d'une version : tout, sauf le secret. */
const SELECT_VERSIONS = `
  SELECT s.kid, s.created_at, s.retired_at,
         (s.secret = ?) AS placeholder,
         (SELECT COUNT(*) FROM users u
           WHERE u.backup_kid = s.kid AND u.exclus = 0) AS comptes
    FROM backup_key_secrets s
   ORDER BY s.kid DESC
`;

const _versions = async (conn = pool) => {
  const [rows] = await conn.query(SELECT_VERSIONS, [PLACEHOLDER_SECRET]);
  return rows.map((r) => ({
    kid: Number(r.kid),
    createdAt: r.created_at,
    retiredAt: r.retired_at,
    // Tant que le secret vaut son marqueur de déploiement, le serveur REFUSE
    // de servir la clé : aucune sauvegarde ne peut être écrite. C'est une
    // protection voulue, mais elle est muette côté application.
    placeholder: Boolean(Number(r.placeholder)),
    active: r.retired_at == null,
    comptes: Number(r.comptes) || 0,
  }));
};

/** `GET /admin/backup/keys` */
const getKeys = async (_req, res) => {
  try {
    const versions = await _versions();
    const active = versions.filter((v) => v.active);
    res.json({
      versions,
      // La version qui chiffrera la prochaine sauvegarde : la plus récente
      // non retirée. Calculée ici plutôt qu'à l'écran, pour que la règle ne
      // puisse pas diverger de `backupKeyService.currentKey`.
      courante: active.length ? active[0].kid : null,
      // Un compte sans version utilisable ne peut plus sauvegarder du tout.
      utilisable: active.some((v) => !v.placeholder),
    });
  } catch (error) {
    console.error('[Admin] getKeys error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * `POST /admin/backup/keys` — engendre une nouvelle version et retire les
 * précédentes.
 *
 * Les anciennes sont retirées, jamais supprimées : elles continuent de servir
 * à relire les archives qui les portent. C'est exactement ce que « rotation »
 * doit vouloir dire ici.
 */
const rotateKey = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[{ maxKid }]] = await conn.query(
      'SELECT COALESCE(MAX(kid), 0) AS maxKid FROM backup_key_secrets FOR UPDATE',
    );
    const kid = Number(maxKid) + 1;

    // 32 octets, la longueur de la clé dérivée. Engendré ici : ni saisi, ni
    // transmis, ni affiché — personne n'a besoin de le connaître.
    const secret = crypto.randomBytes(KEY_BYTES).toString('base64');

    await conn.execute(
      'INSERT INTO backup_key_secrets (kid, secret) VALUES (?, ?)',
      [kid, secret],
    );
    // Les précédentes sortent du service pour l'écriture. Sans ce geste, la
    // liste afficherait plusieurs versions « actives » alors qu'une seule
    // serait jamais employée : un état vrai en base, trompeur à l'écran.
    const [maj] = await conn.execute(
      'UPDATE backup_key_secrets SET retired_at = NOW() WHERE kid < ? AND retired_at IS NULL',
      [kid],
    );

    await conn.commit();
    console.log(
      `[BackupKey] rotation par admin=${req.user?.alanyaID ?? '-'} → kid=${kid}, `
        + `${maj.affectedRows} version(s) retirée(s)`,
    );
    res.json({ kid, retirees: maj.affectedRows, versions: await _versions() });
  } catch (error) {
    await conn.rollback();
    console.error('[Admin] rotateKey error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    conn.release();
  }
};

/**
 * `POST /admin/backup/keys/:kid/retire` — sort une version du service.
 *
 * Elle reste lisible : les archives qui la portent se restaurent toujours.
 */
const retireKey = async (req, res) => {
  const kid = Number.parseInt(req.params.kid, 10);
  if (!Number.isInteger(kid) || kid <= 0) {
    return res.status(400).json({ error: 'Version invalide' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [actives] = await conn.query(
      'SELECT kid FROM backup_key_secrets WHERE retired_at IS NULL FOR UPDATE',
    );
    const restantes = actives.filter((r) => Number(r.kid) !== kid);
    if (!actives.some((r) => Number(r.kid) === kid)) {
      await conn.rollback();
      return res.status(404).json({ error: 'Version inconnue ou déjà retirée' });
    }
    if (restantes.length === 0) {
      await conn.rollback();
      // Refusé plutôt qu'exécuté avec un avertissement : sans version active,
      // plus aucune sauvegarde ne peut être écrite, et l'inscrit ne verrait
      // qu'un échec sans cause. Il faut d'abord en créer une nouvelle.
      return res.status(409).json({
        error: 'Dernière version active : créez-en une nouvelle avant de la retirer',
        code: 'BACKUP_KEY_LAST_ACTIVE',
      });
    }

    await conn.execute(
      'UPDATE backup_key_secrets SET retired_at = NOW() WHERE kid = ?',
      [kid],
    );
    await conn.commit();
    console.log(
      `[BackupKey] retrait par admin=${req.user?.alanyaID ?? '-'} → kid=${kid}`,
    );
    res.json({ kid, versions: await _versions() });
  } catch (error) {
    await conn.rollback();
    console.error('[Admin] retireKey error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    conn.release();
  }
};

module.exports = { getKeys, rotateKey, retireKey };
