const pool = require('../config/db');
const {
  currentKey,
  keyByKid,
  BackupSecretUnavailable,
} = require('../services/backupKeyService');

/**
 * Journal des accès aux clés de sauvegarde.
 *
 * Ce point d'accès est le joyau de la couronne : qui l'obtient peut déchiffrer
 * une sauvegarde. La trace n'empêche rien à elle seule, mais elle rend un abus
 * constatable — ce qui est la différence entre une garantie tenable et une
 * promesse en l'air.
 */
const _auditKeyAccess = (req, kid, outcome) => {
  console.log(
    `[BackupKey] alanyaID=${req.user.alanyaID} appareil=${req.user.appareilId ?? '-'} ` +
      `kid=${kid} ip=${req.ip} → ${outcome}`
  );
};

const _sendKey = async (req, res, loader, requestedKid) => {
  try {
    const { kid, key } = await loader();
    _auditKeyAccess(req, kid, 'servie');
    return res.json({ kid, key: key.toString('base64') });
  } catch (e) {
    if (e instanceof BackupSecretUnavailable) {
      _auditKeyAccess(req, requestedKid ?? '-', `refusée (${e.message})`);
      // 503 et non 500 : la configuration du serveur est en cause, pas la
      // requête. L'application invitera à réessayer plus tard plutôt que de
      // laisser croire à une perte de données.
      return res.status(503).json({
        error: 'Service de sauvegarde indisponible',
        code: 'BACKUP_KEY_UNAVAILABLE',
      });
    }
    console.error('[BackupKey] ERROR:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/** `GET /api/backup/key` — version courante, pour écrire une sauvegarde. */
exports.getCurrentKey = (req, res) =>
  _sendKey(req, res, () => currentKey(req.user.alanyaID));

/**
 * `GET /api/backup/key/:kid` — version donnée, pour relire une archive.
 *
 * Sans cette route, remplacer le secret rendrait illisibles toutes les
 * sauvegardes déjà déposées.
 */
exports.getKeyByKid = (req, res) => {
  const kid = Number.parseInt(req.params.kid, 10);
  if (!Number.isInteger(kid) || kid <= 0) {
    return res.status(400).json({ error: 'kid invalide' });
  }
  return _sendKey(req, res, () => keyByKid(req.user.alanyaID, kid), kid);
};

/**
 * Masque une adresse de messagerie : `ama.nguema@gmail.com` → `a•••@gmail.com`.
 *
 * On ne conserve jamais l'adresse complète. La première lettre et le domaine
 * suffisent à guider l'inscrit vers le bon compte le jour de la restauration ;
 * en garder davantage serait accumuler de la donnée personnelle sans usage.
 */
const _maskEmail = (raw) => {
  const value = String(raw ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const domain = value.slice(at);
  if (domain.length > 48) return null;
  return `${value[0]}•••${domain}`;
};

/**
 * `PUT /api/backup/meta` — l'application déclare qu'une sauvegarde a réussi.
 *
 * ── Pourquoi le serveur porte cette information ──
 *
 * Sur un téléphone neuf, l'application doit savoir qu'une sauvegarde existe
 * AVANT de demander un compte Google. Sans cela, il faudrait interroger Drive
 * à l'aveugle au tout premier démarrage — donc réclamer un compte tiers au pire
 * moment, et à tout le monde, y compris à ceux qui n'ont jamais rien
 * sauvegardé.
 *
 * **Aucun contenu ne transite ici** : une date, une taille, une version de clé,
 * un décompte, et une adresse masquée.
 */
exports.putMeta = async (req, res) => {
  const { bytes, kid, messageCount, accountEmail } = req.body || {};

  const size = Number.parseInt(bytes, 10);
  const keyId = Number.parseInt(kid, 10);
  if (!Number.isInteger(size) || size <= 0 || !Number.isInteger(keyId)) {
    return res.status(400).json({ error: 'Métadonnée incomplète' });
  }

  try {
    await pool.execute(
      `UPDATE users
          SET backup_last_at = NOW(),
              backup_bytes = ?,
              backup_kid = ?,
              backup_message_count = ?,
              backup_account_hint = ?
        WHERE alanyaID = ?`,
      [
        size,
        keyId,
        Number.isInteger(Number.parseInt(messageCount, 10))
          ? Number.parseInt(messageCount, 10)
          : null,
        _maskEmail(accountEmail),
        req.user.alanyaID,
      ]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('[BackupMeta] ERROR:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * `GET /api/backup/meta` — ce que le serveur sait de la dernière sauvegarde.
 *
 * Appelé à la connexion sur un appareil neuf. `hasBackup: false` est une
 * réponse, pas une erreur : elle permet à l'application de ne PAS réclamer de
 * compte Google à un inscrit qui n'a jamais sauvegardé.
 */
exports.getMeta = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT backup_last_at, backup_bytes, backup_kid,
              backup_message_count, backup_account_hint
         FROM users WHERE alanyaID = ? LIMIT 1`,
      [req.user.alanyaID]
    );
    const row = rows[0];
    if (!row || !row.backup_last_at) {
      return res.json({ hasBackup: false });
    }
    return res.json({
      hasBackup: true,
      lastAt: row.backup_last_at,
      bytes: Number(row.backup_bytes ?? 0),
      kid: row.backup_kid ?? null,
      messageCount: row.backup_message_count ?? null,
      accountHint: row.backup_account_hint ?? null,
    });
  } catch (e) {
    console.error('[BackupMeta] ERROR:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

exports._maskEmail = _maskEmail;
