const pool = require('../config/db');

/**
 * Cache court alanyaID → identité d'affichage (nom, pseudo, avatar, fuseau).
 *
 * Sert le chemin critique de `message:send` : ces cinq colonnes sont la seule
 * partie du payload `message:sent` que l'émetteur ne connaît pas déjà au
 * moment de l'INSERT. Les lire ici évite la relecture `SELECT m.* JOIN users
 * JOIN pays` qui coûtait un aller-retour SQL complet — vers une base qui n'est
 * pas sur la même machine que le backend — avant chaque accusé d'envoi.
 *
 * TTL 60 s, sur le modèle de `conversationParticipantsCache` : un expéditeur
 * enchaîne ses messages, le cache est chaud dès le deuxième. Un changement de
 * nom ou d'avatar met donc au pire une minute à se refléter dans le payload
 * temps réel, ce que `invalidateSenderIdentity` permet d'éviter au point de
 * modification du profil.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const _cache = new Map();

const SENDER_IDENTITY_SQL = `
  SELECT u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
         p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset
    FROM users u
    LEFT JOIN pays p ON u.idPays = p.idPays
   WHERE u.alanyaID = ?
   LIMIT 1
`;

/** Forme neutre : un expéditeur introuvable ne doit pas casser l'envoi. */
const EMPTY_IDENTITY = Object.freeze({
  sender_nom: null,
  sender_pseudo: null,
  sender_avatar: null,
  messageTz: null,
  messageTzOffset: null,
});

async function getSenderIdentity(senderID) {
  const key = Number(senderID);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.identity;

  const [rows] = await pool.execute(SENDER_IDENTITY_SQL, [key]);
  const row = rows[0];
  const identity = row
    ? {
        sender_nom: row.sender_nom ?? null,
        sender_pseudo: row.sender_pseudo ?? null,
        sender_avatar: row.sender_avatar ?? null,
        messageTz: row.messageTz ?? null,
        messageTzOffset: row.messageTzOffset ?? null,
      }
    : EMPTY_IDENTITY;

  _cache.set(key, { at: Date.now(), identity });
  // Garde-fou mémoire : purge opportuniste au-delà de MAX_ENTRIES clés.
  if (_cache.size > MAX_ENTRIES) {
    _cache.delete(_cache.keys().next().value);
  }
  return identity;
}

/** À appeler quand le profil change (nom, pseudo, avatar, pays). */
function invalidateSenderIdentity(senderID) {
  _cache.delete(Number(senderID));
}

module.exports = {
  getSenderIdentity,
  invalidateSenderIdentity,
  SENDER_IDENTITY_SQL,
  EMPTY_IDENTITY,
  _cache,
};
