const pool = require('../config/db');

/**
 * Valide replyToID avant INSERT : doit exister dans la même conversation.
 * Retourne null si absent, ≤ 0, introuvable ou supprimé (replyToContent reste affichable).
 */
async function resolveReplyToID(conversationID, replyToID) {
  const id = Number(replyToID);
  if (!Number.isFinite(id) || id <= 0) return null;

  const [rows] = await pool.execute(
    `SELECT msgID FROM message
     WHERE msgID = ? AND conversationID = ? AND isDeleted = 0
     LIMIT 1`,
    [id, conversationID]
  );
  return rows.length ? id : null;
}

/**
 * Comme `resolveReplyToID`, mais rend aussi le `type` du message cité : le
 * serveur en a besoin pour ne pas recopier le JSON d'un sticker dans
 * `replyToContent`. Une seule requête, comme avant.
 *
 * @returns {Promise<{id: number|null, type: number|null}>}
 */
async function resolveReplyTarget(conversationID, replyToID) {
  const id = Number(replyToID);
  if (!Number.isFinite(id) || id <= 0) return { id: null, type: null };

  const [rows] = await pool.execute(
    `SELECT msgID, type FROM message
     WHERE msgID = ? AND conversationID = ? AND isDeleted = 0
     LIMIT 1`,
    [id, conversationID]
  );
  return rows.length ? { id, type: Number(rows[0].type) } : { id: null, type: null };
}

module.exports = { resolveReplyToID, resolveReplyTarget };
