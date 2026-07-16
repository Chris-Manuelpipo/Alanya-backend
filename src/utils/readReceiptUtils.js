const pool = require('../config/db');

/**
 * Marque les messages entrants comme lus, remet unreadCount à 0 pour le lecteur,
 * met à jour lastMessageStatus sur la conversation, et notifie l'expéditeur.
 */
const markConversationReadBy = async ({
  conversationID,
  readerID,
  io = null,
  userSockets = null,
}) => {
  await pool.execute(
    `UPDATE message SET status = 3, readAt = NOW(),
            deliveredAt = COALESCE(deliveredAt, NOW())
     WHERE conversationID = ? AND senderID != ? AND status < 3`,
    [conversationID, readerID],
  );
  await pool.execute(
    'UPDATE conv_participants SET unreadCount = 0 WHERE conversID = ? AND alanyaID = ?',
    [conversationID, readerID],
  );
  await pool.execute(
    `UPDATE conversation SET lastMessageStatus = 3
     WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 3`,
    [conversationID, readerID],
  );

  if (!io) return;

  const payload = {
    conversationID: Number(conversationID),
    status: 3,
    byUserID: Number(readerID),
    at: new Date().toISOString(),
  };
  io.to(`conversation_${conversationID}`).emit('message:status', payload);
  if (!userSockets) return;

  const [participants] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, readerID],
  );
  for (const p of participants) {
    const sid = userSockets.get(p.alanyaID);
    if (sid) io.to(sid).emit('message:status', payload);
  }
};

module.exports = { markConversationReadBy };
