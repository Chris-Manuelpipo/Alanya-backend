const pool = require('../../../config/db');
const { evaluateDirectMessageSend } = require('../../../utils/blockUtils');
const { resolveLastMessagePreview } = require('../../../utils/mediaAlbum');
const { resolveReplyToID } = require('../../../utils/resolveReplyToID');

const joinConversation = (io, socket) => {
  socket.on('join_conversation', async (data) => {
    try {
      const { conversationID } = data;
      socket.join(`conversation_${conversationID}`);
      socket.emit('joined_conversation', { conversationID });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });
};

const messageSend = (io, socket) => {
  socket.on('message:send', async (data) => {
    try {
      if (!socket.authenticated) {
        return socket.emit('error', {
          message: 'Unauthenticated',
          code: 'UNAUTHENTICATED',
        });
      }

      const {
        conversationID, content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb,
        replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0, clientId,
        clickSentAt,
      } = data;
      const senderID = socket.alanyaID;

      if (!conversationID || (!content && !mediaUrl)) {
        return socket.emit('error', {
          message: 'conversationID and (content or mediaUrl) required',
        });
      }

      const blockEval = await evaluateDirectMessageSend(conversationID, senderID);
      if (blockEval.isDirect && blockEval.action === 'reject') {
        return socket.emit('error', {
          message: 'Cannot message blocked user',
          code: blockEval.code || 'BLOCKED_BY_SENDER',
        });
      }
      const silentDrop = blockEval.isDirect && blockEval.action === 'silent';

      const resolvedReplyToID = await resolveReplyToID(conversationID, replyToID);
      const resolvedReplyToContent = resolvedReplyToID != null ? (replyToContent ?? null) : null;

      const [result] = await pool.execute(
        `INSERT INTO message
           (senderID, conversationID, content, type, status, sendAt,
            clickSentAt,
            mediaUrl, mediaName, mediaDuration, mediaThumb, replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce)
         VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          senderID, conversationID, content ?? null, type,
          clickSentAt ? new Date(clickSentAt) : null,
          mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null, mediaThumb ?? null,
          resolvedReplyToID, resolvedReplyToContent, isStatusReply,
          isForwarded ? 1 : 0, isViewOnce ? 1 : 0,
        ],
      );

      const msgID = result.insertId;

      if (!silentDrop) {
        await pool.execute(
          `UPDATE conversation
           SET lastMessage = ?, lastMessageAt = NOW(),
               lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
           WHERE conversID = ?`,
          [
            resolveLastMessagePreview({ content, mediaName, type, isViewOnce }),
            senderID, type, conversationID,
          ],
        );

        await pool.execute(
          'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
          [conversationID, senderID],
        );
      }

      const [rows] = await pool.execute(
        `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
                p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset
         FROM message m
         JOIN users u ON m.senderID = u.alanyaID
         LEFT JOIN pays p ON u.idPays = p.idPays
         WHERE m.msgID = ?`,
        [msgID],
      );

      const msg = rows[0];

      if (!silentDrop) {
        const [participants] = await pool.execute(
          'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
          [conversationID, senderID],
        );

        for (const p of participants) {
          io.to(`user_${p.alanyaID}`).emit('message:received', msg);
        }

        const [sender] = await pool.execute(
          'SELECT nom FROM users WHERE alanyaID = ?', [senderID],
        );
        const senderName = sender[0]?.nom ?? 'Talky';

        const [convRows] = await pool.execute(
          'SELECT isGroup, GroupName FROM conversation WHERE conversID = ?',
          [conversationID],
        );
        const conv = convRows[0] ?? {};
        const notifyFields = {
          content,
          mediaName,
          type,
          isViewOnce,
          isGroup: !!conv.isGroup,
          groupName: conv.GroupName ?? '',
        };

        setTimeout(() => {
          const { notifyNewMessage } = require('../../../services/notificationService');
          notifyNewMessage(conversationID, senderID, senderName, notifyFields).catch((e) =>
            console.warn('[FCM notification]', e.message),
          );
        }, 0);
      }

      socket.emit('message:sent', { msgID, clientId, ...msg });
    } catch (error) {
      console.error('[Socket message:send]', error.message);
      socket.emit('error', { message: error.message });
    }
  });
};

module.exports = { joinConversation, messageSend };
