
const pool = require('../../config/db');
const { notifyIncomingCall, notifyGroupCall, notifyCallEnded } = require('../../services/notificationService');
const { maxParticipants, maxInvitees } = require('../../constants/participantLimits');
const { isBlockedEitherWay } = require('../../utils/blockUtils');
const pendingCalls = require('../state/pendingCalls');
 
const groupRooms = new Map();

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function getRoomParticipants(room) {
  if (!room) return null;
  return room.participants ?? room;
}

function createRoomState(isVideo, callerID, callerInfo) {
  const participants = new Map();
  if (callerID != null) {
    participants.set(callerID, callerInfo);
  }
  return { isVideo: !!isVideo, participants };
}
 
const callUser = (io, socket, userSockets) => {
  socket.on('call_user', async (data) => {
    try {
      if (!socket.authenticated) {
        console.warn('[Socket call_user] ** Tentative non authentifiée');
        return;
      }

      const { targetUserId, callerId, callerName, callerPhoto, isVideo, offer } = data;
      const targetID = toInt(targetUserId);
      const callerID = toInt(callerId) || socket.alanyaID;

      console.log(`[Socket call_user] 📞 Appel: ${callerID} → ${targetID} (${isVideo ? 'vidéo' : 'audio'})`);

      if (!targetID || !offer) {
        console.warn('[Socket call_user] ** Données invalides', { targetID, offerExists: !!offer });
        socket.emit('call_failed', { reason: 'Données d\'appel invalides' });
        return;
      }

      if (await isBlockedEitherWay(callerID, targetID)) {
        socket.emit('call_failed', { reason: 'Appel impossible', code: 'CALL_BLOCKED' });
        return;
      }

      let callID = null;
      try {
        const [result] = await pool.execute(
          `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, start_time)
           VALUES (?, ?, ?, 0, NOW(), NOW())`,
          [callerID, targetID, isVideo ? 1 : 0]
        );
        callID = result.insertId;
        socket.currentCallID = callID;
        socket.currentCallTarget = targetID;
      } catch (dbErr) {
        console.warn('[Socket call_user] DB insert failed:', dbErr.message);
      }

      const incomingPayload = {
        callId:      callID != null ? String(callID) : null,
        callerId:    String(callerID),
        callerName:  callerName  || '',
        callerPhoto: callerPhoto || null,
        isVideo:     isVideo     || false,
        offer,
      };

      // Bufferise l'appel : si le destinataire est hors-ligne (app fermée), il sera
      // réveillé par FCM puis l'event `incoming_call` lui sera rejoué à sa reconnexion.
      pendingCalls.set(targetID, incomingPayload);

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        console.log(`[Socket call_user] !! Envoi incoming_call à socket ${targetSocketId}`);
        io.to(targetSocketId).emit('incoming_call', incomingPayload);
      } else {
        console.warn(`[Socket call_user] ** Utilisateur ${targetID} non trouvé en socket — fallback FCM + rejeu à la reconnexion`);
      }

      notifyIncomingCall(targetID, callerID, callerName, callerPhoto, isVideo, callID)
        .catch((err) => console.warn('[Socket call_user] FCM error:', err.message));
    } catch (error) {
      console.error('[Socket call_user]', error.message);
      socket.emit('call_failed', { reason: error.message });
    }
  });
};

const answerCall = (io, socket, userSockets) => {
  socket.on('answer_call', async (data) => {
    try {
      if (!socket.authenticated) {
        console.warn('[Socket answer_call] ** Non authentifié');
        return;
      }
      const { callerId, answer } = data;

      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      if (!callerID || !answer) {
        console.warn('[Socket answer_call] ** Données invalides', { callerID, answerExists: !!answer });
        return;
      }

      console.log(`[Socket answer_call] 📞 Réponse: Receiver ${receiverID} → Caller ${callerID}`);

      // L'appel est traité : plus besoin de le rejouer au destinataire.
      pendingCalls.clear(receiverID);

      try {
        const [result] = await pool.execute(
          `UPDATE callHistory
           SET start_time = NOW(), status = 1
           WHERE IDcall = (
             SELECT IDcall FROM (
               SELECT IDcall FROM callHistory
               WHERE idCaller = ? AND idReceiver = ?
               ORDER BY created_at DESC
               LIMIT 1
             ) AS sub
           )`,
          [callerID, receiverID]
        );
        console.log(`[Socket answer_call] !! DB updated: ${result.affectedRows} row(s)`);
      } catch (dbErr) {
        console.warn('[Socket answer_call] DB update failed:', dbErr.message);
      }

      const callerSocketId = userSockets.get(callerID);
      if (callerSocketId) {
        console.log(`[Socket answer_call] !! Envoi call_answered à socket ${callerSocketId}`);
        io.to(callerSocketId).emit('call_answered', { answer });
      } else {
        console.warn(`[Socket answer_call] ** Caller ${callerID} non trouvé. UserSockets: [${Array.from(userSockets.keys()).join(', ')}]`);
      }
    } catch (error) {
      console.error('[Socket answer_call]', error.message);
    }
  });
};

const rejectCall = (io, socket, userSockets) => {
  socket.on('reject_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { callerId } = data;
      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      if (!callerID) return;

      // Appel refusé : ne pas le rejouer au destinataire.
      pendingCalls.clear(receiverID);

      try {
        await pool.execute(
          `UPDATE callHistory
           SET status = 2
           WHERE IDcall = (
             SELECT IDcall FROM (
               SELECT IDcall FROM callHistory
               WHERE idCaller = ? AND idReceiver = ?
               ORDER BY created_at DESC
               LIMIT 1
             ) AS sub
           )`,
          [callerID, receiverID]
        );
      } catch (dbErr) {
        console.warn('[Socket reject_call] DB update failed:', dbErr.message);
      }

      const callerSocketId = userSockets.get(callerID);
      if (callerSocketId) {
        io.to(callerSocketId).emit('call_rejected', {});
      }

      // Envoyer FCM au caller pour arrêter la sonnerie (cas où receiver est en background)
      notifyCallEnded(callerID, receiverID, 'Destinataire')
        .catch((err) => console.warn('[Socket reject_call] FCM notifyCallEnded error:', err.message));
    } catch (error) {
      console.error('[Socket reject_call]', error.message);
    }
  });
};

const iceCandidate = (io, socket, userSockets) => {
  socket.on('ice_candidate', (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, candidate } = data;
      const targetID = toInt(targetUserId);
      if (!targetID || !candidate) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('ice_candidate', { candidate });
      }
    } catch (error) {
      console.error('[Socket ice_candidate]', error.message);
    }
  });
};

const endCall = (io, socket, userSockets) => {
  socket.on('end_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId } = data;
      const targetID = toInt(targetUserId);
      const callerID = socket.alanyaID;

      // Appel terminé/annulé : ne pas le rejouer au destinataire.
      if (targetID) pendingCalls.clear(targetID);

      if (callerID) {
        try {
          await pool.execute(
            `UPDATE callHistory
             SET duree = GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW()))
             WHERE IDcall = (
               SELECT IDcall FROM (
                 SELECT IDcall FROM callHistory
                 WHERE (idCaller = ? OR idReceiver = ?)
                   AND (idCaller = ? OR idReceiver = ?)
                 ORDER BY created_at DESC
                 LIMIT 1
               ) AS sub
             )`,
            [callerID, callerID, targetID || callerID, targetID || callerID]
          );
        } catch (dbErr) {
          console.warn('[Socket end_call] DB update failed:', dbErr.message);
        }
      }

      if (targetID) {
        const targetSocketId = userSockets.get(targetID);
        if (targetSocketId) {
          io.to(targetSocketId).emit('call_ended', {});
        }

        // Envoyer FCM au receiver pour arrêter la sonnerie (cas où receiver est en background)
        notifyCallEnded(targetID, callerID, 'L\'appelant')
          .catch((err) => console.warn('[Socket end_call] FCM notifyCallEnded error:', err.message));
      }

      socket.currentCallID     = null;
      socket.currentCallTarget = null;
    } catch (error) {
      console.error('[Socket end_call]', error.message);
    }
  });
};

//  APPELS DE GROUPE 

const createGroupCall = (io, socket, userSockets) => {
  socket.on('create_group_call', (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId, callerId, callerName, callerPhoto, isVideo, targetUserIds } = data;
      if (!roomId || !Array.isArray(targetUserIds)) return;

      const callerID = toInt(callerId) || socket.alanyaID;
      const videoCall = !!isVideo;
      const inviteLimit = maxInvitees(videoCall);
      const uniqueTargets = [...new Set(
        targetUserIds.map(toInt).filter((id) => id && id !== callerID),
      )];

      if (uniqueTargets.length > inviteLimit) {
        return socket.emit('error', {
          message: `Maximum ${maxParticipants(videoCall)} participants en ${videoCall ? 'vidéo' : 'audio'} (vous inclus)`,
          code: 'GROUP_CALL_TOO_MANY',
        });
      }

      groupRooms.set(
        roomId,
        createRoomState(videoCall, callerID, {
          userName: callerName || '',
          userPhoto: callerPhoto || null,
        }),
      );

      socket.join(`group_${roomId}`);
      socket.currentGroupRoom = roomId;

      const fcmTargets = [];
      for (const targetID of uniqueTargets) {
        fcmTargets.push(targetID);
        const targetSocketId = userSockets.get(targetID);
        if (targetSocketId) {
          io.to(targetSocketId).emit('group_call_invite', {
            callerId:    String(callerID),
            callerName:  callerName  || '',
            callerPhoto: callerPhoto || null,
            isVideo:     videoCall,
            roomId,
          });
        }
      }

      // FCM en parallèle pour les destinataires hors-ligne / app fermée
      notifyGroupCall(fcmTargets, callerID, callerName, callerPhoto, videoCall, roomId)
        .catch((err) => console.warn('[Socket create_group_call] FCM error:', err.message));
    } catch (error) {
      console.error('[Socket create_group_call]', error.message);
    }
  });
};

const joinGroupCall = (io, socket, userSockets) => {
  socket.on('join_group_call', (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId, userId, userName, userPhoto } = data;
      if (!roomId || !userId) return;

      const userID = toInt(userId) || socket.alanyaID;

      let room = groupRooms.get(roomId);
      if (!room || !(room.participants instanceof Map)) {
        room = createRoomState(false, null, null);
        groupRooms.set(roomId, room);
      }

      const participants = getRoomParticipants(room);
      const limit = maxParticipants(room.isVideo);
      if (!participants.has(userID) && participants.size >= limit) {
        return socket.emit('error', {
          message: `Cet appel ${room.isVideo ? 'vidéo' : 'audio'} est complet (${limit} participants max)`,
          code: 'GROUP_CALL_FULL',
        });
      }

      participants.set(userID, { userName: userName || '', userPhoto: userPhoto || null });

      socket.join(`group_${roomId}`);
      socket.currentGroupRoom = roomId;

      socket.to(`group_${roomId}`).emit('group_user_joined', {
        roomId,
        userId:    String(userID),
        userName:  userName  || '',
        userPhoto: userPhoto || null,
      });

      const participantIds = Array.from(participants.keys()).map(String);
      socket.emit('group_participants', { roomId, participants: participantIds });
    } catch (error) {
      console.error('[Socket join_group_call]', error.message);
    }
  });
};

const leaveGroupCall = (io, socket, userSockets) => {
  socket.on('leave_group_call', (data) => {
    try {
      const { roomId } = data || {};
      const room = roomId ? groupRooms.get(roomId) : null;
      const participants = getRoomParticipants(room);

      if (participants && socket.alanyaID) {
        participants.delete(socket.alanyaID);
        if (participants.size === 0) groupRooms.delete(roomId);
      }

      const rId = roomId || socket.currentGroupRoom;
      if (rId) {
        socket.to(`group_${rId}`).emit('group_user_left', {
          roomId: rId,
          userId: String(socket.alanyaID),
        });
        socket.leave(`group_${rId}`);
      }

      socket.currentGroupRoom = null;
    } catch (error) {
      console.error('[Socket leave_group_call]', error.message);
    }
  });
};

const endGroupCall = (io, socket, userSockets) => {
  socket.on('end_group_call', (data) => {
    try {
      const { roomId } = data || {};
      const rId = roomId || socket.currentGroupRoom;
      if (!rId) return;

      groupRooms.delete(rId);
      io.to(`group_${rId}`).emit('group_call_ended', {});

      const roomSockets = io.sockets.adapter.rooms.get(`group_${rId}`);
      if (roomSockets) {
        for (const sid of roomSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.leave(`group_${rId}`);
            s.currentGroupRoom = null;
          }
        }
      }
    } catch (error) {
      console.error('[Socket end_group_call]', error.message);
    }
  });
};

const groupOffer = (io, socket, userSockets) => {
  socket.on('group_offer', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, fromUserId, offer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !offer) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('group_offer', {
          fromUserId: String(fromUserId || socket.alanyaID),
          offer,
          roomId,
        });
      }
    } catch (error) {
      console.error('[Socket group_offer]', error.message);
    }
  });
};

const groupAnswer = (io, socket, userSockets) => {
  socket.on('group_answer', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, fromUserId, answer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !answer) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('group_answer', {
          fromUserId: String(fromUserId || socket.alanyaID),
          answer,
          roomId,
        });
      }
    } catch (error) {
      console.error('[Socket group_answer]', error.message);
    }
  });
};

const groupIceCandidate = (io, socket, userSockets) => {
  socket.on('group_ice_candidate', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, fromUserId, candidate, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !candidate) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('group_ice_candidate', {
          fromUserId: String(fromUserId || socket.alanyaID),
          candidate,
          roomId,
        });
      }
    } catch (error) {
      console.error('[Socket group_ice_candidate]', error.message);
    }
  });
};

module.exports = {
  callUser,
  answerCall,
  rejectCall,
  iceCandidate,
  endCall,
  createGroupCall,
  joinGroupCall,
  leaveGroupCall,
  endGroupCall,
  groupOffer,
  groupAnswer,
  groupIceCandidate,
};