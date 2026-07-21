const pool = require('../../../config/db');
const { isBlockedBy, getDirectConversationPeer } = require('../../../utils/blockUtils');
const { notifyMessageStatus } = require('../../../utils/notifyMessageStatus');

const messageDelivered = (io, socket) => {
  socket.on('message:delivered', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data;
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      const peerId = await getDirectConversationPeer(conversationID, userID);
      if (peerId != null && await isBlockedBy(userID, peerId)) return;

      await pool.execute(
        `UPDATE message SET status = 2, deliveredAt = NOW()
         WHERE conversationID = ? AND senderID != ? AND status = 1`,
        [conversationID, userID],
      );
      await pool.execute(
        `UPDATE conversation SET lastMessageStatus = 2
         WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 2`,
        [conversationID, userID],
      );
      await notifyMessageStatus(io, conversationID, 2, userID);
    } catch (e) {
      console.warn('[Socket message:delivered]', e.message);
    }
  });
};

const messageRead = (io, socket) => {
  socket.on('message:read', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data;
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      const peerId = await getDirectConversationPeer(conversationID, userID);
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
    } catch (e) {
      console.warn('[Socket message:read]', e.message);
    }
  });
};

module.exports = { messageDelivered, messageRead };
