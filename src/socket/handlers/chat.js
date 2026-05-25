const pool = require('../../config/db');

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

      const { conversationID, content, type = 0, mediaUrl, mediaName, mediaDuration, replyToID, replyToContent, isStatusReply = 0, clientId } = data;
      const senderID = socket.alanyaID; // !! Utiliser l'ID du socket authentifié

      if (!conversationID || (!content && !mediaUrl)) {
        return socket.emit('error', { 
          message: 'conversationID and (content or mediaUrl) required' 
        });
      }

      // ÉTAPE 1 : PERSISTER le message en DB
      const [result] = await pool.execute(
        `INSERT INTO message
           (senderID, conversationID, content, type, status, sendAt,
            mediaUrl, mediaName, mediaDuration, replyToID, replyToContent, isStatusReply)
         VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?)`,
        [
          senderID, conversationID, content ?? null, type,
          mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null,
          replyToID ?? null, replyToContent ?? null, isStatusReply,
        ]
      );

      const msgID = result.insertId;

      // ÉTAPE 2 : Mettre à jour résumé conversation (statut 1 = envoyé)
      await pool.execute(
        `UPDATE conversation
         SET lastMessage = ?, lastMessageAt = NOW(),
             lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
         WHERE conversID = ?`,
        [
          content ? content.substring(0, 200) : (mediaName ?? 'Média'),
          senderID, type, conversationID,
        ]
      );

      // ÉTAPE 3 : Incrémenter compteur non-lus pour autres participants
      await pool.execute(
        'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
        [conversationID, senderID]
      );

      // ÉTAPE 4 : Récupérer message complet avec infos sender
      const [rows] = await pool.execute(
        `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar
         FROM message m
         JOIN users u ON m.senderID = u.alanyaID
         WHERE m.msgID = ?`,
        [msgID]
      );

      const msg = rows[0];

      // ÉTAPE 5 : Diffuser le message UNE SEULE FOIS à chaque autre participant.
      // On vise la room personnelle `user_<id>` (rejointe à l'auth) — fiable que
      // le destinataire ait ou non ouvert la conversation. L'émetteur n'est PAS
      // notifié ici : il reçoit son propre message via `message:sent` (évite les
      // doublons côté émetteur).
      const [participants] = await pool.execute(
        'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
        [conversationID, senderID]
      );

      for (const p of participants) {
        io.to(`user_${p.alanyaID}`).emit('message:received', msg);
      }

      // ÉTAPE 6 : Notif FCM aux autres participants
      const [sender] = await pool.execute(
        'SELECT nom FROM users WHERE alanyaID = ?', [senderID]
      );
      const senderName = sender[0]?.nom ?? 'Talky';
      
      // Import async pour éviter circular dependency
      setTimeout(() => {
        const { notifyNewMessage } = require('../../services/notificationService');
        notifyNewMessage(conversationID, senderID, senderName, content, type).catch(e => 
          console.warn('[FCM notification]', e.message)
        );
      }, 0);

      // Renvoyer clientId pour que l'émetteur retrouve son message optimiste.
      socket.emit('message:sent', { msgID, clientId, ...msg });
    } catch (error) {
      console.error('[Socket message:send]', error.message);
      socket.emit('error', { message: error.message });
    }
  });
};

const typingStart = (io, socket, userSockets) => {
  socket.on('typing:start', (data) => {
    const { conversationID, userID } = data;
    socket.to(`conversation_${conversationID}`).emit('typing:started', { userID });
  });
};

const typingStop = (io, socket, userSockets) => {
  socket.on('typing:stop', (data) => {
    const { conversationID, userID } = data;
    socket.to(`conversation_${conversationID}`).emit('typing:stopped', { userID });
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
      await pool.execute(
        `UPDATE message SET status = 3, readAt = NOW()
         WHERE conversationID = ? AND senderID != ? AND status < 3`,
        [conversationID, userID]
      );
      await pool.execute(
        'UPDATE conv_participants SET unreadCount = 0 WHERE conversID = ? AND alanyaID = ?',
        [conversationID, userID]
      );
      // Reflète l'accusé "lu" (✓✓ bleu) sur l'aperçu du dernier message.
      await pool.execute(
        `UPDATE conversation SET lastMessageStatus = 3
         WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 3`,
        [conversationID, userID]
      );
      await _notifyStatus(io, conversationID, 3, userID, userSockets);
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

    io.emit('presence:updated', {
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

    io.emit('presence:updated', {
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

  const meetingID = socket.currentMeetingID;
  if (meetingID) {
    socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
      meetingID,
      userID: String(userID),
    });
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

  io.emit('presence:updated', {
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
