/**
 * Service des bundles servis : qui a le droit de lire quelles clés, et
 * consommation atomique d'une clé à usage unique.
 *
 * ── Pourquoi l'autorisation, alors que ce sont des clés PUBLIQUES ──
 *
 * Rien dans un bundle n'est secret. Mais le servir n'est pas gratuit : chaque
 * lecture consomme une clé à usage unique, et le stock est fini. Sans garde,
 * n'importe quel compte viderait le stock de n'importe qui en boucle, et tous
 * les amorçages suivants retomberaient sur trois demi-échanges au lieu de
 * quatre — une dégradation silencieuse de la sécurité du premier message,
 * obtenue sans aucun privilège.
 *
 * La règle retenue : on ne lit le bundle d'un appareil que s'il est à soi, ou
 * s'il appartient à quelqu'un avec qui on partage déjà une conversation, et
 * qu'aucun des deux n'a bloqué l'autre. Elle ne protège pas un secret, elle
 * protège une ressource.
 *
 * ── Le plafond par paire ──
 *
 * Partager une conversation ne suffit pas : une conversation se crée avec un
 * simple numéro public (docs/e2ee, chapitre 20). Au-delà de
 * `CONSOMMATION_PAR_HEURE` clés consommées en une heure par un même compte
 * sur les appareils d'un même autre compte, le bundle est servi SANS clé à
 * usage unique. Pas de refus : l'amorçage se fait sur trois demi-échanges,
 * la messagerie continue, et seul le stock de la victime est épargné.
 *
 * ── Pourquoi `SKIP LOCKED` ──
 *
 * Deux correspondants qui ouvrent une session avec le même appareil au même
 * instant doivent repartir avec DEUX clés différentes. Un `FOR UPDATE` seul
 * ferait attendre le second sur la ligne verrouillée par le premier, puis lui
 * servirait la même ligne une fois `claimed_at` posé — ou le ferait expirer.
 * `SKIP LOCKED` lui fait sauter la ligne en cours de réservation et prendre
 * la suivante. MySQL 8 l'accepte depuis 8.0.1.
 */

const pool = require('../config/db');
const { bundleSortie } = require('../utils/e2eeBundle');

// Borne du lot demandé. Une conversation de groupe de 200 membres à deux
// appareils chacun dépasse cette borne : le client découpe alors sa demande.
// Sans plafond, une seule requête pourrait réclamer des dizaines de milliers
// de bundles et autant de verrous de ligne.
const BUNDLES_PAR_LOT_MAX = 200;

// Clés à usage unique qu'un compte peut consommer, en une heure, sur les
// appareils d'un même autre compte. Un correspondant honnête en consomme une
// par appareil et par installation : vingt couvrent largement une
// réinstallation en série, pas une boucle.
const CONSOMMATION_PAR_HEURE = 20;

/**
 * Règle d'autorisation, sans base : garde les appareils du demandeur et ceux
 * des comptes avec qui il partage une conversation, sauf blocage.
 *
 * Le blocage écarte aussi la lecture : une personne bloquée n'a aucune raison
 * d'ouvrir une session, et la lui permettre lui servirait à savoir combien
 * d'appareils chiffrent chez celle qui l'a bloquée.
 *
 * @param {Array<{id, alanyaID}>} lignes  appareils non révoqués demandés
 * @param {Set<number>} partages  comptes avec qui une conversation est partagée
 * @param {Set<number>} bloques   comptes bloqués dans un sens ou l'autre
 */
function filtreAutorises(lignes, demandeurId, partages, bloques) {
  const moi = Number(demandeurId);
  return lignes
    .filter((l) => {
      const compte = Number(l.alanyaID);
      if (compte === moi) return true;
      return partages.has(compte) && !bloques.has(compte);
    })
    .map((l) => ({ appareilId: Number(l.id), alanyaID: Number(l.alanyaID) }));
}

/**
 * Ce qu'il reste à consommer pour chaque compte, d'après ce qui l'a déjà été
 * dans l'heure. Fonction pure.
 *
 * @param {Array<{alanyaID, n}>} dejaConsommees
 * @param {number[]} comptes
 * @returns {Map<number, number>}
 */
function quotasRestants(dejaConsommees, comptes, plafond = CONSOMMATION_PAR_HEURE) {
  const parCompte = new Map(
    (dejaConsommees || []).map((r) => [Number(r.alanyaID), Number(r.n) || 0]),
  );
  return new Map(
    comptes.map((c) => [Number(c), Math.max(0, plafond - (parCompte.get(Number(c)) || 0))]),
  );
}

/**
 * Filtre les appareils que `demandeurId` a le droit de lire.
 *
 * Deux requêtes, pas une : résoudre d'abord l'ensemble des comptes avec qui
 * le demandeur partage une conversation — restreint aux comptes effectivement
 * demandés, donc borné par la taille du lot — puis lire les appareils. La
 * variante en un seul `EXISTS` corrélé par appareil referait la jointure
 * `conv_participants × conv_participants` pour chaque ligne.
 *
 * `revoked_at IS NULL` : un appareil déconnecté à distance ne reçoit plus
 * rien. Lui servir son bundle ferait chiffrer pour un destinataire qui ne
 * lira jamais, et le message apparaîtrait livré.
 */
async function appareilsAutorises(demandeurId, appareilIds) {
  if (appareilIds.length === 0) return [];

  const [lignes] = await pool.query(
    `SELECT a.id, a.alanyaID
       FROM appareils a
      WHERE a.id IN (?) AND a.revoked_at IS NULL`,
    [appareilIds],
  );
  if (lignes.length === 0) return [];

  const comptes = [...new Set(lignes.map((l) => Number(l.alanyaID)))];
  const autres = comptes.filter((c) => c !== Number(demandeurId));

  let partages = new Set();
  let bloques = new Set();
  if (autres.length > 0) {
    const [rel] = await pool.query(
      `SELECT DISTINCT p2.alanyaID
         FROM conv_participants p1
         JOIN conv_participants p2 ON p2.conversID = p1.conversID
        WHERE p1.alanyaID = ? AND p2.alanyaID IN (?)`,
      [demandeurId, autres],
    );
    partages = new Set(rel.map((r) => Number(r.alanyaID)));

    // `blocked(alanyaID, idCallerBlock)` : alanyaID a bloqué idCallerBlock
    // (voir utils/blockUtils.js). Les deux sens comptent.
    const [blocs] = await pool.query(
      `SELECT alanyaID, idCallerBlock FROM blocked
        WHERE (alanyaID = ? AND idCallerBlock IN (?))
           OR (idCallerBlock = ? AND alanyaID IN (?))`,
      [demandeurId, autres, demandeurId, autres],
    );
    bloques = new Set(blocs.map((b) => (
      Number(b.alanyaID) === Number(demandeurId) ? Number(b.idCallerBlock) : Number(b.alanyaID)
    )));
  }

  return filtreAutorises(lignes, demandeurId, partages, bloques);
}

/**
 * Réserve une clé à usage unique pour cet appareil, ou rend `null`.
 *
 * `null` n'est pas une erreur : l'amorçage X3DH se fera sur trois
 * demi-échanges. C'est plus faible — le premier message perd sa protection
 * contre une fuite ultérieure de la clé d'identité — mais c'est fonctionnel,
 * et refuser la conversation serait pire.
 *
 * `ORDER BY id` : les plus anciennes d'abord, pour que le stock tourne au
 * lieu de laisser vieillir un fond de file jamais servi.
 */
async function reserveUneCle(conn, appareilId, demandeurId = null) {
  const [libres] = await conn.execute(
    `SELECT id, key_id, public_key
       FROM e2ee_one_time_prekeys
      WHERE appareil_id = ? AND claimed_at IS NULL
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [appareilId],
  );
  if (libres.length === 0) return null;

  await conn.execute(
    'UPDATE e2ee_one_time_prekeys SET claimed_at = NOW(), claimed_by = ? WHERE id = ?',
    [demandeurId, libres[0].id],
  );
  return libres[0];
}

/**
 * Sert les bundles des appareils demandés, avec une clé à usage unique
 * réservée pour chacun.
 *
 * Une transaction pour tout le lot : si elle échoue à mi-parcours, aucune clé
 * n'est marquée consommée. Le client rejouera et retrouvera son stock entier
 * — alors qu'un lot partiel lui aurait fait perdre les clés des appareils
 * déjà servis sans qu'il en reçoive les bundles.
 *
 * Les appareils sans bundle publié sont rendus dans `sansCles` plutôt
 * qu'omis : l'émetteur doit pouvoir distinguer « cet appareil ne sait pas
 * encore chiffrer, j'envoie en clair » de « cet appareil n'existe pas ».
 */
async function serviceBundles(demandeurId, appareilIds) {
  const autorises = await appareilsAutorises(demandeurId, appareilIds);
  if (autorises.length === 0) {
    return { bundles: [], sansCles: [], refuses: appareilIds.map(Number) };
  }

  const permis = new Set(autorises.map((a) => a.appareilId));
  const refuses = appareilIds.map(Number).filter((id) => !permis.has(id));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [cles] = await conn.query(
      `SELECT * FROM e2ee_device_keys WHERE appareil_id IN (?)`,
      [[...permis]],
    );
    const parAppareil = new Map(cles.map((c) => [Number(c.appareil_id), c]));

    const comptes = [...new Set(autorises.map((a) => a.alanyaID))];
    const [consommees] = await conn.query(
      `SELECT a.alanyaID, COUNT(*) AS n
         FROM e2ee_one_time_prekeys o
         JOIN appareils a ON a.id = o.appareil_id
        WHERE o.claimed_by = ?
          AND a.alanyaID IN (?)
          AND o.claimed_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        GROUP BY a.alanyaID`,
      [demandeurId, comptes],
    );
    const restants = quotasRestants(consommees, comptes);

    const bundles = [];
    for (const { appareilId, alanyaID } of autorises) {
      const ligne = parAppareil.get(appareilId);
      if (!ligne) continue;
      let otpk = null;
      if (restants.get(alanyaID) > 0) {
        otpk = await reserveUneCle(conn, appareilId, demandeurId);
        if (otpk) restants.set(alanyaID, restants.get(alanyaID) - 1);
      }
      bundles.push(bundleSortie(ligne, otpk));
    }

    await conn.commit();
    return {
      bundles,
      sansCles: autorises
        .map((a) => a.appareilId)
        .filter((id) => !parAppareil.has(id)),
      refuses,
    };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Normalise la liste d'identifiants reçue du client. */
function normaliseAppareilIds(entree) {
  if (!Array.isArray(entree)) {
    const err = new Error('appareilIds doit être une liste');
    err.code = 'E2EE_APPAREILS_INVALIDE';
    throw err;
  }
  const ids = [...new Set(entree.map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    const err = new Error('appareilIds vide');
    err.code = 'E2EE_APPAREILS_INVALIDE';
    throw err;
  }
  if (ids.length > BUNDLES_PAR_LOT_MAX) {
    const err = new Error(
      `appareilIds limité à ${BUNDLES_PAR_LOT_MAX} par requête, ${ids.length} reçus`,
    );
    err.code = 'E2EE_APPAREILS_TROP';
    throw err;
  }
  return ids;
}

module.exports = {
  BUNDLES_PAR_LOT_MAX,
  CONSOMMATION_PAR_HEURE,
  filtreAutorises,
  quotasRestants,
  appareilsAutorises,
  reserveUneCle,
  serviceBundles,
  normaliseAppareilIds,
};
