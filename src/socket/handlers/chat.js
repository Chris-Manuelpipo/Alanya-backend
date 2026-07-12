const pool = require('../../config/db');
const { evaluateDirectMessageSend, shouldSuppressDirectInteraction, isBlockedBy, getDirectConversationPeer, emitPresenceUpdate } = require('../../utils/blockUtils');
const { resolveLastMessagePreview } = require('../../utils/mediaAlbum');
const { resolveReplyToID } = require('../../utils/resolveReplyToID');
const { markConversationReadBy } = require('../../utils/readReceiptUtils');
const pendingCalls = require('../state/pendingCalls');
const callState = require('../state/callState');
const meetingMuteStates = require('../state/meetingMuteStates');
const meetingVideoStates = require('../state/meetingVideoStates');
const { notifyCallEnded } = require('../../services/notificationService');

const _fetchMessageWithSender = async (msgID) => {
  const [rows] = await pool.execute(
    `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar
     FROM message m
     JOIN users u ON m.senderID = u.alanyaID
     WHERE m.msgID = ?`,
    [msgID],
  );
  return rows[0] ?? null;
};

const _findMessageByClientId = async (senderID, clientId) => {
  const normalized = typeof clientId === 'string' ? clientId.trim() : '';
  if (!normalized) return null;
  const [rows] = await pool.execute(
    `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar
     FROM message m
     JOIN users u ON m.senderID = u.alanyaID
     WHERE m.senderID = ? AND m.clientID = ?
     LIMIT 1`,
    [senderID, normalized],
  );
  return rows[0] ?? null;
};

/** Diffuse message:received (+ FCM optionnel) aux autres participants. */
const _deliverMessageToParticipants = async (
  io,
  conversationID,
  senderID,
  msg,
  { skipFcm = false, notifyFields = null } = {},
) => {
  const [participants] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, senderID],
  );

  for (const p of participants) {
    io.to(`user_${p.alanyaID}`).emit('message:received', msg);
  }

  if (skipFcm) return;

  const fields = notifyFields ?? {
    content: msg.content,
    mediaName: msg.mediaName,
    type: msg.type,
    isViewOnce: msg.isViewOnce,
  };

  const [sender] = await pool.execute(
    'SELECT nom FROM users WHERE alanyaID = ?', [senderID],
  );
  const senderName = sender[0]?.nom ?? 'Talky';

  const [convRows] = await pool.execute(
    'SELECT isGroup, GroupName FROM conversation WHERE conversID = ?',
    [conversationID],
  );
  const conv = convRows[0] ?? {};

  setTimeout(() => {
    const { notifyNewMessage } = require('../../services/notificationService');
    notifyNewMessage(conversationID, senderID, senderName, {
      ...fields,
      isGroup: !!conv.isGroup,
      groupName: conv.GroupName ?? '',
    }).catch((e) => console.warn('[FCM notification]', e.message));
  }, 0);
};

/**
 * Réponse idempotente : confirme l'émetteur ET re-diffuse aux membres.
 * Les clients dédupliquent déjà message:received ; sans rebroadcast, un retry
 * outbox (même clientId) persistait le message (✓) sans jamais le livrer.
 */
const _emitExistingMessage = async (io, socket, existing, normalizedClientId) => {
  console.warn(
    `[Socket message:send] idempotent hit sender=${existing.senderID} clientId=${normalizedClientId} msgID=${existing.msgID} conv=${existing.conversationID} → rebroadcast`,
  );
  await _deliverMessageToParticipants(
    io,
    existing.conversationID,
    existing.senderID,
    existing,
    { skipFcm: true },
  );
  socket.emit('message:sent', {
    msgID: existing.msgID,
    clientId: normalizedClientId,
    ...existing,
  });
};

const joinConversation = (io, socket, userSockets) => {
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

const messageSend = (io, socket, userSockets) => {
  socket.on('message:send', async (data) => {
    try {
      // Vérifier authentification socket
      if (!socket.authenticated) {
        return socket.emit('error', { 
          message: 'Unauthenticated',
          code: 'UNAUTHENTICATED',
        });
      }

      const { conversationID, content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb, replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0, clientId } = data;
      const senderID = socket.alanyaID; // !! Utiliser l'ID du socket authentifié

      if (!conversationID || (!content && !mediaUrl)) {
        return socket.emit('error', { 
          message: 'conversationID and (content or mediaUrl) required' 
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

      const normalizedClientId =
        typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null;

      // Idempotence : un même clientId ne doit créer qu'un seul message serveur.
      if (normalizedClientId) {
        const existing = await _findMessageByClientId(senderID, normalizedClientId);
        if (existing) {
          return _emitExistingMessage(io, socket, existing, normalizedClientId);
        }
      }

      // ÉTAPE 1 : PERSISTER le message en DB
      let msgID;
      try {
        const [result] = await pool.execute(
          `INSERT INTO message
             (senderID, conversationID, content, type, status, sendAt,
              mediaUrl, mediaName, mediaDuration, mediaThumb, replyToID, replyToContent,
              isStatusReply, isForwarded, isViewOnce, clientID)
           VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            senderID, conversationID, content ?? null, type,
            mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null, mediaThumb ?? null,
            resolvedReplyToID, resolvedReplyToContent, isStatusReply,
            isForwarded ? 1 : 0, isViewOnce ? 1 : 0,
            normalizedClientId,
          ],
        );
        msgID = result.insertId;
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY' && normalizedClientId) {
          const existing = await _findMessageByClientId(senderID, normalizedClientId);
          if (existing) {
            return _emitExistingMessage(io, socket, existing, normalizedClientId);
          }
        }
        throw insertErr;
      }

      if (!silentDrop) {
        // ÉTAPE 2 : Mettre à jour résumé conversation (statut 1 = envoyé)
        await pool.execute(
          `UPDATE conversation
           SET lastMessage = ?, lastMessageAt = NOW(),
               lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
           WHERE conversID = ?`,
          [
            resolveLastMessagePreview({ content, mediaName, type, isViewOnce }),
            senderID, type, conversationID,
          ]
        );

        // ÉTAPE 3 : Incrémenter compteur non-lus pour autres participants
        await pool.execute(
          'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
          [conversationID, senderID]
        );
      }

      // ÉTAPE 4 : Récupérer message complet avec infos sender
      const msg = await _fetchMessageWithSender(msgID);
      if (!msg) {
        return socket.emit('error', { message: 'Message not found after insert' });
      }

      if (!silentDrop) {
        const notifyFields = {
          content,
          mediaName,
          type,
          isViewOnce,
        };
        await _deliverMessageToParticipants(
          io,
          conversationID,
          senderID,
          msg,
          { notifyFields },
        );
      }

      // Renvoyer clientId pour que l'émetteur retrouve son message optimiste.
      socket.emit('message:sent', {
        msgID,
        clientId: normalizedClientId ?? clientId,
        ...msg,
      });
    } catch (error) {
      console.error('[Socket message:send]', error.message);
      socket.emit('error', { message: error.message });
    }
  });
};

const _emitTypingToParticipants = async (io, socket, conversationID, senderID, event, payload) => {
  const [participants] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, senderID]
  );
  let emitToRoom = false;
  for (const p of participants) {
    const suppressed = await shouldSuppressDirectInteraction(
      conversationID, senderID, p.alanyaID,
    );
    if (suppressed) continue;
    io.to(`user_${p.alanyaID}`).emit(event, payload);
    emitToRoom = true;
  }
  if (emitToRoom) {
    socket.to(`conversation_${conversationID}`).emit(event, payload);
  }
};

const typingStart = (io, socket, userSockets) => {
  socket.on('typing:start', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { conversationID } = data || {};
      if (!conversationID) return;
      const userID = socket.alanyaID;
      const payload = {
        conversationID: Number(conversationID),
        userID: Number(userID),
      };
      await _emitTypingToParticipants(io, socket, conversationID, userID, 'typing:started', payload);
    } catch (error) {
      console.error('[Socket typing:start]', error.message);
    }
  });
};

const typingStop = (io, socket, userSockets) => {
  socket.on('typing:stop', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { conversationID } = data || {};
      if (!conversationID) return;
      const userID = socket.alanyaID;
      const payload = {
        conversationID: Number(conversationID),
        userID: Number(userID),
      };
      await _emitTypingToParticipants(io, socket, conversationID, userID, 'typing:stopped', payload);
    } catch (error) {
      console.error('[Socket typing:stop]', error.message);
    }
  });
};
 

const _notifyStatus = async (io, conversationID, status, byUserID, userSockets) => {
  const payload = { conversationID: Number(conversationID), status, byUserID: Number(byUserID) };
  io.to(`conversation_${conversationID}`).emit('message:status', payload);
  try {
    const [participants] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, byUserID]
    );
    for (const p of participants) {
      const sid = userSockets.get(p.alanyaID);
      if (sid) io.to(sid).emit('message:status', payload);
    }
  } catch (e) {
    console.warn('[Socket message:status] notify failed:', e.message);
  }
};

const messageDelivered = (io, socket, userSockets) => {
  socket.on('message:delivered', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data;
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      const peerId = await getDirectConversationPeer(conversationID, userID);
      if (peerId != null && await isBlockedBy(userID, peerId)) return;

      await pool.execute(
        `UPDATE message SET status = 2
         WHERE conversationID = ? AND senderID != ? AND status = 1`,
        [conversationID, userID]
      );
      // Reflète l'accusé "livré" sur l'aperçu (dernier message = celui de l'autre).
      await pool.execute(
        `UPDATE conversation SET lastMessageStatus = 2
         WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 2`,
        [conversationID, userID]
      );
      await _notifyStatus(io, conversationID, 2, userID, userSockets);
    } catch (e) {
      console.warn('[Socket message:delivered]', e.message);
    }
  });
};

const messageRead = (io, socket, userSockets) => {
  socket.on('message:read', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data;
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      const peerId = await getDirectConversationPeer(conversationID, userID);
      if (peerId != null && await isBlockedBy(userID, peerId)) return;

      await markConversationReadBy({
        conversationID,
        readerID: userID,
        io,
        userSockets,
      });
    } catch (e) {
      console.warn('[Socket message:read]', e.message);
    }
  });
};

// Présence 
const presenceOnline = (io, socket, userSockets) => {
  socket.on('presence:online', async (data) => {
    const userID = typeof data === 'object' ? data.userID : data;
    if (!userID) return;

    userSockets.set(Number(userID), socket.id);
    socket.alanyaID = Number(userID); // utilisé par le handler disconnect

    try {
      await pool.execute(
        'UPDATE users SET is_online = 1, last_seen = NOW() WHERE alanyaID = ?',
        [userID]
      );
    } catch (e) {
      console.warn('[Socket presence:online] DB update failed:', e.message);
    }

    await emitPresenceUpdate(io, userID, {
      userID: Number(userID),
      online: true,
      lastSeen: new Date().toISOString(),
    });
  });
};

const presenceOffline = (io, socket, userSockets) => {
  socket.on('presence:offline', async (data) => {
    const userID = typeof data === 'object' ? data.userID : data;
    if (!userID) return;

    userSockets.delete(Number(userID));

    try {
      await pool.execute(
        'UPDATE users SET is_online = 0, last_seen = NOW() WHERE alanyaID = ?',
        [userID]
      );
    } catch (e) {
      console.warn('[Socket presence:offline] DB update failed:', e.message);
    }

    await emitPresenceUpdate(io, userID, {
      userID: Number(userID),
      online: false,
      lastSeen: new Date().toISOString(),
    });
  });
};
 
const handleDisconnect = async (io, socket, userSockets) => {
  const userID = socket.alanyaID;
  if (!userID) return;

  userSockets.delete(userID);
  pendingCalls.markUndelivered(userID);

  // Nettoyage d'un appel 1-à-1 en cours/en sonnerie : on remet les deux
  // participants à « idle » et on prévient le pair encore connecté (call_ended
  // socket + FCM pour couper sa sonnerie), sauf si l'utilisateur a juste été
  // réveillé par un push (état ringing conservé pour rejouer l'offre au retour).
  const callEntry = callState.getEntry(userID);
  if (callEntry && callEntry.status === 'in_call') {
    const peerID = callEntry.peerId;
    callState.clear(userID);
    if (peerID != null) {
      callState.clear(peerID);
      pendingCalls.clear(peerID);
      const peerSocketId = userSockets.get(peerID);
      if (peerSocketId) {
        io.to(peerSocketId).emit('call_ended', {});
      }
      notifyCallEnded(peerID, userID, 'L\'appelant')
        .catch((err) => console.warn('[Socket disconnect] notifyCallEnded error:', err.message));
    }
  }

  const meetingID = socket.currentMeetingID;
  if (meetingID) {
    socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
      meetingID,
      userID: String(userID),
    });
    meetingMuteStates.removeUser(meetingID, userID);
    meetingVideoStates.removeUser(meetingID, userID);
    try {
      await pool.execute(
        `UPDATE participant
         SET connecte = 0,
             duree = TIMESTAMPDIFF(SECOND, start_time, NOW())
         WHERE idMeeting = ? AND IDparticipant = ?`,
        [meetingID, userID]
      );
    } catch (e) {
      console.warn('[Socket disconnect] participant cleanup failed:', e.message);
    }
    socket.currentMeetingID = null;
  }

  try {
    await pool.execute(
      'UPDATE users SET is_online = 0, last_seen = NOW() WHERE alanyaID = ?',
      [userID]
    );
  } catch (e) {
    console.warn('[Socket disconnect] DB update failed:', e.message);
  }

  await emitPresenceUpdate(io, userID, {
    userID: Number(userID),
    online: false,
    lastSeen: new Date().toISOString(),
  });
};

module.exports = {
  joinConversation,
  messageSend,
  typingStart,
  typingStop,
  messageDelivered,
  messageRead,
  presenceOnline,
  presenceOffline,
  handleDisconnect,
};
