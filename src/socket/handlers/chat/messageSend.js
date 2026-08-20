const pool = require('../../../config/db');
const { evaluateDirectMessageSend } = require('../../../utils/blockUtils');
const { assertCanSendToConversation } = require('../../../utils/groupSendPolicy');
const {
  sanitizeMentions,
  serializeMentionsColumn,
} = require('../../../utils/mentions');
const { resolveLastMessagePreview } = require('../../../utils/mediaAlbum');
const { resolveReplyToID } = require('../../../utils/resolveReplyToID');
const {
  getCachedParticipants,
  setCachedParticipants,
} = require('../../../utils/conversationParticipantsCache');
const { MESSAGE_INSERT_SQL, messageInsertParams, insertMessageThumb } = require('../../../utils/messageInsert');

// `mt.thumb` rejoint APRÈS m.* et réencodé en base64 : mysql2 retourne un
// objet JS où la dernière colonne du même nom l'emporte, donc `mediaThumb`
// prend la valeur de message_thumb sans qu'il soit nécessaire d'énumérer les
// colonnes de `message` une par une. Contrat JSON inchangé côté client
// (audit scalabilité 06/08/2026 §2.2, migration 060).
const MSG_SELECT = `
  SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
         p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
         TO_BASE64(mt.thumb) AS mediaThumb
  FROM message m
  JOIN users u ON m.senderID = u.alanyaID
  LEFT JOIN pays p ON u.idPays = p.idPays
  LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
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

/** Nom expéditeur + infos groupe en une seule requête (hors chemin critique). */
async function loadNotifyContext(conversationID, senderID) {
  const [rows] = await pool.execute(
    `SELECT u.nom AS senderName, c.isGroup, c.GroupName AS groupName
     FROM users u
     CROSS JOIN conversation c
     WHERE u.alanyaID = ? AND c.conversID = ?
     LIMIT 1`,
    [senderID, conversationID],
  );
  const row = rows[0] || {};
  return {
    senderName: row.senderName ?? 'Talky',
    isGroup: !!row.isGroup,
    groupName: row.groupName ?? '',
  };
}

async function loadParticipantsExcept(conversationID, senderID) {
  const cached = getCachedParticipants(conversationID, senderID);
  if (cached) return cached;
  const [participants] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, senderID],
  );
  setCachedParticipants(conversationID, senderID, participants);
  return participants;
}

function emitSendFailed(socket, { clientId, code, message }) {
  socket.emit('message:send_failed', {
    clientId: clientId || null,
    code,
    message,
  });
}

function logMsgPath(clientId, stage, t0) {
  const ms = t0 != null ? Date.now() - t0 : 0;
  console.log(`[MsgPath] clientId=${clientId} stage=${stage} ms_since_received=${ms}`);
}

const joinConversation = (io, socket) => {
  socket.on('join_conversation', async (data) => {
    try {
      // La room `conversation_<id>` reçoit message:updated, message:deleted,
      // message:reaction, message:pinned, message:viewed et le typing. Sans ces
      // deux gardes, n'importe quelle socket — même non authentifiée — pouvait
      // la rejoindre et écouter la vie d'une conversation dont elle n'est pas.
      if (!socket.authenticated) {
        return socket.emit('error', {
          message: 'Unauthenticated',
          code: 'UNAUTHENTICATED',
        });
      }

      const conversationID = parseInt(data?.conversationID, 10);
      if (!conversationID || conversationID < 1) return;

      const [rows] = await pool.execute(
        'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
        [conversationID, socket.alanyaID],
      );
      if (rows.length === 0) {
        return socket.emit('error', {
          message: 'Conversation introuvable ou non autorisée',
          code: 'NOT_A_MEMBER',
        });
      }

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
    const t0 = Date.now();
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
        clickSentAt, mentions, mentionsAll = false,
      } = data;
      clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
      const senderID = socket.alanyaID;
      logMsgPath(clientId || '?', 'received', t0);

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

      // Appartenance + mode annonce. `evaluateDirectMessageSend` ci-dessous ne
      // couvre que le 1-1 : sans cette vérification, rien n'empêchait d'écrire
      // dans un groupe dont on n'est pas membre.
      const sendPolicy = await assertCanSendToConversation(conversationID, senderID);
      if (!sendPolicy.ok) {
        emitSendFailed(socket, {
          clientId,
          code: sendPolicy.code,
          message: sendPolicy.message,
        });
        return socket.emit('error', {
          message: sendPolicy.message,
          code: sendPolicy.code,
        });
      }

      const blockEval = await evaluateDirectMessageSend(conversationID, senderID);
      logMsgPath(clientId, 'policy_checked', t0);
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

      const resolvedReplyToID = await resolveReplyToID(conversationID, replyToID);
      const resolvedReplyToContent =
        (replyToContent != null && String(replyToContent).trim() !== '')
          ? replyToContent
          : null;

      // Écrites DANS l'INSERT et pas en UPDATE séparé : l'idempotence devient
      // gratuite, un rejeu du même clientID ne peut ni les dupliquer ni les
      // perdre. L'intersection avec les participants se fait côté serveur.
      const mentionsValue = await sanitizeMentions(
        conversationID, senderID, mentions, { all: mentionsAll === true },
      );

      // Idempotence via unique (senderID, clientID) : insertId = nouveau ou existant.
      const [result] = await pool.execute(
        MESSAGE_INSERT_SQL,
        messageInsertParams({
          senderID,
          conversationID,
          clientId,
          content,
          type,
          clickSentAt,
          mediaUrl,
          mediaName,
          mediaDuration,
          mediaSize,
          mediaPageCount,
          replyToID: resolvedReplyToID,
          replyToContent: resolvedReplyToContent,
          isStatusReply,
          isForwarded,
          isViewOnce,
          mentionsSerialized: serializeMentionsColumn(mentionsValue),
        }),
      );
      const msgID = result.insertId;
      const isNewInsert = result.affectedRows === 1;
      logMsgPath(clientId, 'insert_done', t0);

      // Écriture séparée dans message_thumb (audit scalabilité 06/08/2026
      // §2.2, migration 060) : idempotente (ON DUPLICATE KEY UPDATE), donc
      // sûre à rejouer même sur le chemin replay/course ci-dessous.
      await insertMessageThumb(pool, msgID, mediaThumb);

      // Replay / course : message déjà présent → ack seulement, pas de double unread.
      if (!isNewInsert) {
        const existing = await loadMessageById(msgID) || await loadMessageByClientId(senderID, clientId);
        if (existing) {
          const payload = toClientMsg(existing, clientId);
          socket.emit('message:sent', payload);
          socket.to(`user_${senderID}`).emit('message:sent', payload);
          logMsgPath(clientId, 'sender_ack_emit', t0);
          return;
        }
        emitSendFailed(socket, {
          clientId,
          code: 'INSERT_LOST',
          message: 'Duplicate key but message not found',
        });
        return;
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
        const participants = await loadParticipantsExcept(conversationID, senderID);

        if (participants.length > 0) {
          // Forme tableau : une seule émission, le payload n'est encodé qu'une fois
          // (la boucle unitaire le sérialisait N fois sur l'event loop).
          io.to(participants.map((p) => `user_${p.alanyaID}`))
            .emit('message:received', payload);
        }
        logMsgPath(clientId, 'recipient_emit', t0);

        // Accusé expéditeur immédiatement (avant prep FCM).
        socket.emit('message:sent', payload);
        socket.to(`user_${senderID}`).emit('message:sent', payload);
        logMsgPath(clientId, 'sender_ack_emit', t0);

        // Prep FCM hors chemin critique.
        setImmediate(() => {
          loadNotifyContext(conversationID, senderID)
            .then((ctx) => {
              const notifyFields = {
                content,
                mediaName,
                type,
                isViewOnce,
                isGroup: ctx.isGroup,
                groupName: ctx.groupName,
                msgID,
                clientId,
                // La liste déjà normalisée : le fan-out n'a aucune requête à
                // refaire pour savoir qui est mentionné.
                mentions: mentionsValue,
              };
              const { notifyNewMessage } = require('../../../services/notificationService');
              return notifyNewMessage(
                conversationID,
                senderID,
                ctx.senderName,
                notifyFields,
                io,
              );
            })
            .catch((e) => console.warn('[FCM notification]', e.message));
        });
      } else {
        socket.emit('message:sent', payload);
        socket.to(`user_${senderID}`).emit('message:sent', payload);
        logMsgPath(clientId, 'sender_ack_emit', t0);
      }
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
