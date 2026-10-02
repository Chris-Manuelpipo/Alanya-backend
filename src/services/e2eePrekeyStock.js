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
 * s'il appartient à quelqu'un avec qui on partage déjà une conversation. Elle
 * ne protège pas un secret, elle protège une ressource.
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
  if (autres.length > 0) {
    const [rel] = await pool.query(
      `SELECT DISTINCT p2.alanyaID
         FROM conv_participants p1
         JOIN conv_participants p2 ON p2.conversID = p1.conversID
        WHERE p1.alanyaID = ? AND p2.alanyaID IN (?)`,
      [demandeurId, autres],
    );
    partages = new Set(rel.map((r) => Number(r.alanyaID)));
  }

  return lignes
    .filter((l) => Number(l.alanyaID) === Number(demandeurId)
      || partages.has(Number(l.alanyaID)))
    .map((l) => ({ appareilId: Number(l.id), alanyaID: Number(l.alanyaID) }));
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
async function reserveUneCle(conn, appareilId) {
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
    'UPDATE e2ee_one_time_prekeys SET claimed_at = NOW() WHERE id = ?',
    [libres[0].id],
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

    const bundles = [];
    for (const { appareilId } of autorises) {
      const ligne = parAppareil.get(appareilId);
      if (!ligne) continue;
      const otpk = await reserveUneCle(conn, appareilId);
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
  appareilsAutorises,
  reserveUneCle,
  serviceBundles,
  normaliseAppareilIds,
};
