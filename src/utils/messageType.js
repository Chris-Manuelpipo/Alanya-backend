/**
 * Normalisation du `type` d'un message, partagée par `message:send` (socket)
 * et `POST /api/conversations/:id/messages` (HTTP).
 *
 * ── Pourquoi ──
 *
 * MySQL arrondit un nombre non entier à l'INSERT (`10.4` devient 10). Un client
 * qui envoyait `type: 10.4` (ou `"9.5"`, `"10abc"`) n'était reconnu ni par
 * `estSticker` (Number(10.4) !== 10) ni par aucun autre garde : la colonne
 * `message.type` devenait pourtant 10 — un sticker écrit SANS résolution
 * serveur, gardant `mediaUrl`/`content` du client, sans contrôle de pack, de
 * droit Plus ni de résolution serveur.
 *
 * ── Règle ──
 *
 * On accepte un entier de 0 à 255, donné en nombre ou en chaîne strictement
 * décimale entière (`"10"` oui, `"10.0"`, `"1e2"`, `"0x10"` non). Tout le
 * reste renvoie `null` : l'appelant répond `400 INVALID_PAYLOAD` et n'écrit
 * rien, sur les deux chemins et pour tous les types — la triche ne concerne
 * pas que les stickers.
 */

const TYPE_MAX = 255;

/**
 * @param {*} raw `type` envoyé par le client (nombre, chaîne, undefined…)
 * @returns {number} type normalisé, ou `null` si invalide
 */
function normalizeMessageType(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) {
    n = Number(raw);
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < 0 || n > TYPE_MAX) return null;
  return n;
}

module.exports = { normalizeMessageType, TYPE_MAX };