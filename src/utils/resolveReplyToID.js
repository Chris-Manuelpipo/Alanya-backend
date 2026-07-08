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

module.exports = { resolveReplyToID };
