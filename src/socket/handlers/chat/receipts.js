const pool = require('../../../config/db');
const { isBlockedBy, getCachedDirectConversationPeer } = require('../../../utils/blockUtils');
const { notifyMessageStatus } = require('../../../utils/notifyMessageStatus');
const { markConversationDeliveredBy } = require('../../../utils/deliveryReceiptUtils');

const messageDelivered = (io, socket) => {
  socket.on('message:delivered', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data || {};
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      // Chemin partagé avec POST /api/messages/delivered, l'accusé émis par la
      // couche push quand l'app du destinataire est fermée.
      await markConversationDeliveredBy({ conversationID, recipientID: userID, io });
    } catch (e) {
      console.error('[Socket message:delivered]', e.code || '', e.message);
    }
  });
};

const messageRead = (io, socket) => {
  socket.on('message:read', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data || {};
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      const peerId = await getCachedDirectConversationPeer(conversationID, userID);
      if (peerId != null && await isBlockedBy(userID, peerId)) return;

      await pool.execute(
        `UPDATE message SET status = 3, readAt = NOW(),
                deliveredAt = COALESCE(deliveredAt, NOW())
         WHERE conversationID = ? AND senderID != ? AND status < 3`,
        [conversationID, userID],
      );
      await pool.execute(
        'UPDATE conv_participants SET unreadCount = 0 WHERE conversID = ? AND alanyaID = ?',
        [conversationID, userID],
      );
      await pool.execute(
        `UPDATE conversation SET lastMessageStatus = 3
         WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 3`,
        [conversationID, userID],
      );
      await notifyMessageStatus(io, conversationID, 3, userID);
      io.to(`user_${userID}`).emit('inbox:sync', {
        conversationID: Number(conversationID),
        unreadCount: 0,
        reason: 'read',
      });
      const { notifyMessageReadSync } = require('../../../services/notificationService');
      setImmediate(() => {
        notifyMessageReadSync(userID, conversationID).catch((e) =>
          console.warn('[FCM message_read_sync]', e.message),
        );
      });
    } catch (e) {
      console.error('[Socket message:read]', e.code || '', e.message);
    }
  });
};

module.exports = { messageDelivered, messageRead };
