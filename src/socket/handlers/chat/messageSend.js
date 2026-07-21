const pool = require('../../../config/db');
const { evaluateDirectMessageSend } = require('../../../utils/blockUtils');
const { resolveLastMessagePreview } = require('../../../utils/mediaAlbum');
const { resolveReplyToID } = require('../../../utils/resolveReplyToID');

const MSG_SELECT = `
  SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
         p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset
  FROM message m
  JOIN users u ON m.senderID = u.alanyaID
  LEFT JOIN pays p ON u.idPays = p.idPays
`;

/** Normalise la ligne DB pour le client (clientId camelCase + msgID). */
function toClientMsg(row, clientId) {
  if (!row) return null;
  const id = clientId || row.clientID || row.clientId || null;
  return {
    ...row,
    msgID: row.msgID,
    clientId: id,
    clientID: id,
  };
}

async function loadMessageById(msgID) {
  const [rows] = await pool.execute(`${MSG_SELECT} WHERE m.msgID = ?`, [msgID]);
  return rows[0] || null;
}

async function loadMessageByClientId(senderID, clientId) {
  const [rows] = await pool.execute(
    `${MSG_SELECT} WHERE m.senderID = ? AND m.clientID = ? LIMIT 1`,
    [senderID, clientId],
  );
  return rows[0] || null;
}

function emitSendFailed(socket, { clientId, code, message }) {
  socket.emit('message:send_failed', {
    clientId: clientId || null,
    code,
    message,
  });
}

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
    let clientId = null;
    try {
      if (!socket.authenticated) {
        emitSendFailed(socket, {
          clientId: data?.clientId,
          code: 'UNAUTHENTICATED',
          message: 'Unauthenticated',
        });
        return socket.emit('error', {
          message: 'Unauthenticated',
          code: 'UNAUTHENTICATED',
        });
      }

      const {
        conversationID, content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb,
        mediaSize, mediaPageCount,
        replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
        clickSentAt,
      } = data;
      clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
      const senderID = socket.alanyaID;

      if (!clientId || clientId.length > 64) {
        emitSendFailed(socket, {
          clientId: clientId || null,
          code: 'MISSING_CLIENT_ID',
          message: 'clientId required (max 64 chars)',
        });
        return;
      }

      if (!conversationID || (!content && !mediaUrl)) {
        emitSendFailed(socket, {
          clientId,
          code: 'INVALID_PAYLOAD',
          message: 'conversationID and (content or mediaUrl) required',
        });
        return;
      }

      const blockEval = await evaluateDirectMessageSend(conversationID, senderID);
      if (blockEval.isDirect && blockEval.action === 'reject') {
        const code = blockEval.code || 'BLOCKED_BY_SENDER';
        emitSendFailed(socket, {
          clientId,
          code,
          message: 'Cannot message blocked user',
        });
        return socket.emit('error', {
          message: 'Cannot message blocked user',
          code,
        });
      }
      const silentDrop = blockEval.isDirect && blockEval.action === 'silent';

      // Idempotence : même (senderID, clientID) → toujours le même message.
      const existing = await loadMessageByClientId(senderID, clientId);
      if (existing) {
        return socket.emit('message:sent', toClientMsg(existing, clientId));
      }

      const resolvedReplyToID = await resolveReplyToID(conversationID, replyToID);
      // Garder le texte de citation même si l'ID n'a pas pu être résolu
      // (média encore en ack côté client, ID temporaire, etc.).
      const resolvedReplyToContent =
        (replyToContent != null && String(replyToContent).trim() !== '')
          ? replyToContent
          : null;

      let msgID;
      try {
        const [result] = await pool.execute(
          `INSERT INTO message
             (senderID, conversationID, clientID, content, type, status, sendAt,
              clickSentAt,
              mediaUrl, mediaName, mediaDuration, mediaThumb, mediaSize, mediaPageCount,
              replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce)
           VALUES (?, ?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            senderID, conversationID, clientId, content ?? null, type,
            clickSentAt ? new Date(clickSentAt) : null,
            mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null, mediaThumb ?? null,
            mediaSize ?? null, mediaPageCount ?? null,
            resolvedReplyToID, resolvedReplyToContent, isStatusReply,
            isForwarded ? 1 : 0, isViewOnce ? 1 : 0,
          ],
        );
        msgID = result.insertId;
      } catch (insertErr) {
        // Course concurrente : un autre emit a déjà créé la ligne.
        if (insertErr && (insertErr.code === 'ER_DUP_ENTRY' || insertErr.errno === 1062)) {
          const raced = await loadMessageByClientId(senderID, clientId);
          if (raced) {
            return socket.emit('message:sent', toClientMsg(raced, clientId));
          }
        }
        throw insertErr;
      }

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

      const msg = await loadMessageById(msgID);
      if (!msg) {
        emitSendFailed(socket, {
          clientId,
          code: 'INSERT_LOST',
          message: 'Message inserted but not found',
        });
        return;
      }

      const payload = toClientMsg(msg, clientId);

      if (!silentDrop) {
        const [participants] = await pool.execute(
          'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
          [conversationID, senderID],
        );

        for (const p of participants) {
          io.to(`user_${p.alanyaID}`).emit('message:received', payload);
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
          // Passer `io` : skip FCM si le destinataire est déjà dans user_*.
          notifyNewMessage(conversationID, senderID, senderName, notifyFields, io).catch((e) =>
            console.warn('[FCM notification]', e.message),
          );
        }, 0);
      }

      socket.emit('message:sent', payload);
    } catch (error) {
      console.error('[Socket message:send]', error.message);
      emitSendFailed(socket, {
        clientId,
        code: 'SERVER_ERROR',
        message: error.message,
      });
      socket.emit('error', { message: error.message });
    }
  });
};

module.exports = { joinConversation, messageSend };
