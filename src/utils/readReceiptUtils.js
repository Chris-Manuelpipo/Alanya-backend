const pool = require('../config/db');
const { notifyMessageStatus } = require('./notifyMessageStatus');

/**
 * Marque les messages entrants comme lus, remet unreadCount à 0 pour le lecteur,
 * met à jour lastMessageStatus sur la conversation, et notifie l'expéditeur.
 */
const markConversationReadBy = async ({
  conversationID,
  readerID,
  io = null,
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

  await notifyMessageStatus(io, conversationID, 3, readerID);

  if (io) {
    io.to(`user_${readerID}`).emit('inbox:sync', {
      conversationID: Number(conversationID),
      unreadCount: 0,
      reason: 'read',
    });
  }
};

module.exports = { markConversationReadBy };
