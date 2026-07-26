const pool = require('../config/db');

/**
 * Mentions d'un message — colonne JSON `message.mentions`, format `[45, 46]`.
 *
 * Calqué sur les helpers `reactions` de messageController.js : même parti pris
 * qu'à la migration 019, une liste par message stockée sur la ligne plutôt que
 * dans une table dédiée. `MSG_SELECT` faisant `SELECT m.*`, la colonne circule
 * gratuitement dans message:received, getMessages et /messages/sync.
 *
 * Le client envoie des IDS EXPLICITES, jamais du texte à re-parser : les noms
 * contiennent des espaces (« @Jean Dupont »), et le serveur ne saurait pas
 * découper de façon fiable. En contrepartie il INTERSECTE toujours avec les
 * participants réels — c'est ce qui rend la mention non falsifiable.
 */

/** Au-delà, on cesse de dénormaliser : voir `sanitizeMentions`. */
const MAX_EXPLICIT_MENTIONS = 32;

/**
 * Seuil de dépliage de `@Tous`.
 *
 * En dessous, on stocke la liste complète : le ciblage push devient une simple
 * appartenance à un Set, sans requête. Au-dessus, la colonne JSON enflerait
 * (256 ids ≈ 1,5 ko par message) et on garde le marqueur `"all"`, que
 * `isMentioned` sait interpréter.
 */
const MAX_EXPANDED_ALL = 256;

/** Marqueur d'un `@Tous` non déplié. */
const ALL_MARKER = 'all';

/**
 * Normalise les mentions d'un message avant l'INSERT.
 *
 * @param {number} conversationID
 * @param {number} senderID
 * @param {Array}  rawIds   ids envoyés par le client
 * @param {object} [opts]
 * @param {boolean} [opts.all]  le client a utilisé `@Tous`
 * @returns {Promise<number[]|string|null>} liste d'ids, marqueur `"all"`, ou
 *          null s'il n'y a rien à stocker.
 */
async function sanitizeMentions(conversationID, senderID, rawIds, { all = false } = {}) {
  if (all) {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS n FROM conv_participants WHERE conversID = ?',
      [conversationID],
    );
    const total = Number(rows[0]?.n) || 0;
    // Gros groupe : marqueur seul, le fan-out lira conv_participants.
    if (total > MAX_EXPANDED_ALL) return ALL_MARKER;

    const [members] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID],
    );
    const ids = members.map((r) => Number(r.alanyaID));
    return ids.length > 0 ? ids : null;
  }

  const cleaned = [
    ...new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((i) => parseInt(i, 10))
        .filter((i) => Number.isInteger(i) && i > 0)
        // Se mentionner soi-même ne doit produire aucune notification.
        .filter((i) => i !== Number(senderID)),
    ),
  ].slice(0, MAX_EXPLICIT_MENTIONS);

  if (cleaned.length === 0) return null;

  // Intersection avec les participants réels : c'est ce qui empêche un client
  // modifié de faire sonner le téléphone de quelqu'un qui n'est pas du groupe.
  const placeholders = cleaned.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT alanyaID FROM conv_participants
      WHERE conversID = ? AND alanyaID IN (${placeholders})`,
    [conversationID, ...cleaned],
  );
  const valides = rows.map((r) => Number(r.alanyaID));
  return valides.length > 0 ? valides : null;
}

/** Valeur à passer en paramètre de l'INSERT. */
function serializeMentionsColumn(mentions) {
  if (mentions === ALL_MARKER) return JSON.stringify(ALL_MARKER);
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  return JSON.stringify(mentions);
}

/** Relit la colonne. Renvoie `[]` ou la chaîne `"all"`. */
function parseMentionsColumn(raw) {
  if (raw == null) return [];
  try {
    // mysql2 rend déjà un objet JS pour une colonne JSON ; on couvre les deux.
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value === ALL_MARKER) return ALL_MARKER;
    if (!Array.isArray(value)) return [];
    return value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch (_) {
    return [];
  }
}

/**
 * Cet utilisateur est-il mentionné ?
 *
 * Le marqueur `"all"` vaut pour tout le monde sauf l'expéditeur — c'est
 * exactement le sens de `@Tous`, et ça évite au fan-out de recharger la liste
 * des membres qu'il est déjà en train de parcourir.
 */
function isMentioned(mentions, alanyaID, senderID) {
  if (mentions === ALL_MARKER) return Number(alanyaID) !== Number(senderID);
  if (!Array.isArray(mentions)) return false;
  return mentions.includes(Number(alanyaID));
}

module.exports = {
  sanitizeMentions,
  serializeMentionsColumn,
  parseMentionsColumn,
  isMentioned,
  ALL_MARKER,
  MAX_EXPLICIT_MENTIONS,
  MAX_EXPANDED_ALL,
};
