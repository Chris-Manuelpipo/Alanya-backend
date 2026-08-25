const pool = require('../../config/db');
const { emitToUser, emitToDevice, normalizeDeviceId } = require('../../utils/userSocketRegistry');
const meetingMuteStates = require('../state/meetingMuteStates');
const meetingVideoStates = require('../state/meetingVideoStates');
const meetingDevicePresence = require('../state/meetingDevicePresence');

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

async function emitMeetingSignal(io, toUserID, event, payload) {
  const did = await meetingDevicePresence.getActiveDeviceId(payload.meetingID, toUserID);
  if (!did) {
    console.warn(
      `[Socket ${event}] pas de device cible user=${toUserID} meeting=${payload.meetingID} — drop`,
    );
    return false;
  }
  return emitToDevice(io, toUserID, did, event, payload);
}

async function assertMeetingOwnerSocket(socket, meetingID) {
  const mID = toInt(meetingID);
  const deviceId = normalizeDeviceId(socket.deviceId);
  if (!mID || !deviceId) return null;
  if (Number(socket.currentMeetingID) !== mID) return null;
  if (!(await meetingDevicePresence.isOwnerDevice(mID, socket.alanyaID, deviceId))) {
    return null;
  }
  return mID;
}

// Vérifie que le socket appartient à l'organisateur de la réunion.
async function isOrganiser(socket, meetingID) {
  const mID = toInt(meetingID);
  if (!mID || !socket.alanyaID) return false;
  try {
    const [rows] = await pool.execute(
      'SELECT idOrganiser FROM meeting WHERE idMeeting = ?',
      [mID]
    );
    return rows.length > 0 && rows[0].idOrganiser === socket.alanyaID;
  } catch (err) {
    console.error('[Socket isOrganiser]', err.message);
    return false;
  }
}

const meetingCreate = (io, socket, userSockets) => {
  socket.on('meeting:create', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, organiserID, meetingName } = data;
      const mID = toInt(meetingID);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (mID && deviceId) {
        const claim = await meetingDevicePresence.tryJoin(mID, socket.alanyaID, deviceId, socket.id);
        if (!claim.ok && claim.code === 'ACCOUNT_ALREADY_IN_MEETING') {
          return socket.emit('meeting:join_denied', {
            meetingID: mID,
            code: 'ACCOUNT_ALREADY_IN_MEETING',
            message: 'Cette réunion est déjà active sur un autre de vos appareils.',
          });
        }
      }
      socket.join(`meeting_${meetingID}`);
      socket.currentMeetingID = meetingID;
      socket.emit('meeting:created', { meetingID, meetingName });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });
};
 
const meetingJoinRoom = (io, socket, userSockets) => {
  socket.on('meeting:join_room', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, userID, userName, isMuted, isVideoOff } = data;
      const mID = toInt(meetingID);
      const uID = socket.alanyaID;
      const deviceId = normalizeDeviceId(socket.deviceId);

      if (userID != null && toInt(userID) != null && toInt(userID) !== uID) {
        console.warn(
          `[Socket meeting:join_room] userID spoof payload=${userID} socket=${uID}`,
        );
        return socket.emit('meeting:join_denied', {
          meetingID: mID,
          code: 'USER_ID_MISMATCH',
          message: 'Identité invalide',
        });
      }

      if (!mID) {
        return socket.emit('error', { message: 'meetingID requis' });
      }
      if (!deviceId) {
        return socket.emit('meeting:join_denied', {
          meetingID: mID,
          code: 'DEVICE_ID_REQUIRED',
          message: 'Identifiant appareil requis',
        });
      }

      const claim = await meetingDevicePresence.tryJoin(mID, uID, deviceId, socket.id);
      if (!claim.ok) {
        return socket.emit('meeting:join_denied', {
          meetingID: mID,
          code: claim.code || 'ACCOUNT_ALREADY_IN_MEETING',
          message: 'Cette réunion est déjà active sur un autre de vos appareils.',
        });
      }

      socket.join(`meeting_${mID}`);
      socket.currentMeetingID = mID;

      try {
        await pool.execute(
          'UPDATE participant SET connecte = 1, start_time = NOW() WHERE idMeeting = ? AND IDparticipant = ?',
          [mID, uID],
        );
      } catch (dbErr) {
        console.warn('[Socket meeting:join_room] connecte update:', dbErr.message);
      }

      if (typeof isMuted === 'boolean') {
        await meetingMuteStates.set(mID, uID, isMuted);
      }

      if (typeof isVideoOff === 'boolean') {
        await meetingVideoStates.set(mID, uID, isVideoOff);
      }

      let nom = null;
      let pseudo = null;
      try {
        const [userRows] = await pool.execute(
          'SELECT nom, pseudo FROM users WHERE alanyaID = ?',
          [uID]
        );
        if (userRows.length > 0) {
          nom = userRows[0].nom;
          pseudo = userRows[0].pseudo;
        }
      } catch (err) {
        console.error('[Socket meeting:join_room] user lookup:', err.message);
      }

      const payload = {
        meetingID: mID,
        userID:    String(uID),
        userName:  userName || nom || pseudo || null,
        nom,
        pseudo,
        muteStates: await meetingMuteStates.getSnapshot(mID, uID),
        videoStates: await meetingVideoStates.getSnapshot(mID, uID),
      };

      socket.emit('meeting:room_joined', payload);

      socket.to(`meeting_${mID}`).emit('meeting:user_joined', {
        ...payload,
        isMuted: typeof isMuted === 'boolean' ? isMuted : false,
        isVideoOff: typeof isVideoOff === 'boolean' ? isVideoOff : false,
      });
    } catch (error) {
      console.error('[Socket meeting:join_room]', error.message);
      socket.emit('error', { message: error.message });
    }
  });
};

const meetingJoinRequest = (io, socket, userSockets) => {
  socket.on('meeting:join_request', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, userID, userName } = data;
      socket.to(`meeting_${meetingID}`).emit('meeting:join_requested', {
        meetingID,
        userID,
        userName,
      });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });
};

const meetingJoinAccept = (io, socket, userSockets) => {
  socket.on('meeting:join_accept', async (data) => {
    if (!socket.authenticated) return;
    const { meetingID, userID } = data;
    const uID = toInt(userID);
    if (uID) {
      emitToUser(io, uID, 'meeting:accepted', { meetingID });
    }

    let nom = null;
    let pseudo = null;
    if (uID) {
      try {
        const [userRows] = await pool.execute(
          'SELECT nom, pseudo FROM users WHERE alanyaID = ?',
          [uID]
        );
        if (userRows.length > 0) {
          nom = userRows[0].nom;
          pseudo = userRows[0].pseudo;
        }
      } catch (err) {
        console.error('[Socket meeting:join_accept] user lookup:', err.message);
      }
    }

    socket.to(`meeting_${meetingID}`).emit('meeting:user_joined', {
      meetingID,
      userID:   String(userID),
      userName: nom || pseudo || null,
      nom,
      pseudo,
    });
  });
};

const meetingJoinDecline = (io, socket, userSockets) => {
  socket.on('meeting:join_decline', (data) => {
    if (!socket.authenticated) return;
    const { meetingID, userID } = data;
    const uid = toInt(userID);
    if (uid) {
      emitToUser(io, uid, 'meeting:declined', { meetingID });
    }
  });
};

const meetingStart = (io, socket, userSockets) => {
  socket.on('meeting:start', async (data) => {
    if (!socket.authenticated) return;
    const { meetingID } = data;
    if (!(await isOrganiser(socket, meetingID))) {
      return socket.emit('error', { message: 'Seul l\'organisateur peut démarrer la réunion' });
    }
    io.to(`meeting_${meetingID}`).emit('meeting:started', { meetingID });
  });
};

const meetingEnd = (io, socket, userSockets) => {
  socket.on('meeting:end', async (data) => {
    if (!socket.authenticated) return;
    const { meetingID } = data;

    if (!(await isOrganiser(socket, meetingID))) {
      return socket.emit('error', { message: 'Seul l\'organisateur peut terminer la réunion' });
    }

    try {
      await pool.execute('UPDATE meeting SET isEnd = 1 WHERE idMeeting = ?', [meetingID]);
    } catch (err) {
      console.error('[Socket meeting:end] DB error:', err.message);
    }

    io.to(`meeting_${meetingID}`).emit('meeting:ended', { meetingID });
    await meetingMuteStates.clearMeeting(meetingID);
    await meetingVideoStates.clearMeeting(meetingID);
    await meetingDevicePresence.clearMeeting(meetingID);

    // io.sockets.adapter.rooms/sockets ne voient que CE process : capturer les
    // membres locaux avant de faire partir tout le monde de la room, sinon
    // socketsLeave() (cross-instance, voir plus bas) l'aura déjà vidée ici.
    const localSids = io.sockets.adapter.rooms.get(`meeting_${meetingID}`);

    // Cross-instance : propage le départ de la room via l'adapter Redis à
    // toute socket membre, quelle que soit l'instance qui l'héberge — sans
    // ça, un participant connecté à une AUTRE instance que celle traitant
    // meeting:end continuerait de recevoir les diffusions de cette room.
    io.in(`meeting_${meetingID}`).socketsLeave(`meeting_${meetingID}`);

    // currentMeetingID est une propriété brute lue uniquement en local (jamais
    // via fetchSockets()) : la réinitialiser ne vaut donc que pour les sockets
    // de CE process — une RemoteSocket ne peut pas être mutée à distance.
    if (localSids) {
      for (const sid of localSids) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.currentMeetingID = null;
      }
    }
  });
};

const meetingChat = (io, socket, userSockets) => {
  socket.on('meeting:chat', (data) => {
    if (!socket.authenticated) return;
    const { meetingID, userID, message } = data;
    // N'accepter le chat que d'un socket réellement présent dans la room.
    if (socket.currentMeetingID !== toInt(meetingID)) return;
    io.to(`meeting_${meetingID}`).emit('meeting:message', {
      meetingID,
      userID,
      message,
      sendAt: new Date(),
    });
  });
};

const meetingLeave = (io, socket, userSockets) => {
  socket.on('meeting:leave', async (data) => {
    try {
      if (!socket.authenticated) return;
      const meetingID = data?.meetingID || socket.currentMeetingID;
      if (!meetingID) return;
      const mID = toInt(meetingID);
      const uID = socket.alanyaID;
      const deviceId = normalizeDeviceId(socket.deviceId);

      // Non-owner : no-op (ne libère pas le slot du device actif).
      if (!mID || !deviceId || !(await meetingDevicePresence.isOwnerDevice(mID, uID, deviceId))) {
        console.log(
          `[Socket meeting:leave] no-op non-owner user=${uID} meeting=${meetingID}`,
        );
        return;
      }

      socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
        meetingID,
        userID: String(uID),
      });

      await meetingMuteStates.removeUser(meetingID, uID);
      await meetingVideoStates.removeUser(meetingID, uID);
      await meetingDevicePresence.leave(mID, uID);
      try {
        await pool.execute(
          `UPDATE participant
           SET connecte = 0,
               duree = TIMESTAMPDIFF(SECOND, start_time, NOW())
           WHERE idMeeting = ? AND IDparticipant = ?`,
          [mID, uID],
        );
      } catch (e) {
        console.warn('[Socket meeting:leave] DB:', e.message);
      }
      socket.leave(`meeting_${meetingID}`);
      socket.currentMeetingID = null;
    } catch (error) {
      console.error('[Socket meeting:leave]', error.message);
    }
  });
};

const meetingOffer = (io, socket, userSockets) => {
  socket.on('meeting:offer', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, toUserID, offer } = data;
      const targetID = toInt(toUserID);
      if (!targetID || !offer) return;
      const mID = await assertMeetingOwnerSocket(socket, meetingID);
      if (!mID) return;

      await emitMeetingSignal(io, targetID, 'meeting:offer', {
        fromUserID: String(socket.alanyaID),
        offer,
        meetingID: mID,
      });
    } catch (error) {
      console.error('[Socket meeting:offer]', error.message);
    }
  });
};

const meetingAnswer = (io, socket, userSockets) => {
  socket.on('meeting:answer', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, toUserID, answer } = data;
      const targetID = toInt(toUserID);
      if (!targetID || !answer) return;
      const mID = await assertMeetingOwnerSocket(socket, meetingID);
      if (!mID) return;

      await emitMeetingSignal(io, targetID, 'meeting:answer', {
        fromUserID: String(socket.alanyaID),
        answer,
        meetingID: mID,
      });
    } catch (error) {
      console.error('[Socket meeting:answer]', error.message);
    }
  });
};

const meetingIceCandidate = (io, socket, userSockets) => {
  socket.on('meeting:ice_candidate', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, toUserID, candidate } = data;
      const targetID = toInt(toUserID);
      if (!targetID || !candidate) return;
      const mID = await assertMeetingOwnerSocket(socket, meetingID);
      if (!mID) return;

      await emitMeetingSignal(io, targetID, 'meeting:ice_candidate', {
        fromUserID: String(socket.alanyaID),
        candidate,
        meetingID: mID,
      });
    } catch (error) {
      console.error('[Socket meeting:ice_candidate]', error.message);
    }
  });
};

// État micro (mute) : diffuse à tous les autres participants de la réunion.
// L'émetteur est exclu via `socket.to`. Le userId provient de socket.alanyaID
// (fiable), le meetingID de socket.currentMeetingID en priorité.
const meetingMuteState = (io, socket, userSockets) => {
  socket.on('meeting:mute_state', async (data) => {
    try {
      if (!socket.authenticated) return;
      const mID = socket.currentMeetingID
        || toInt(data && (data.meetingId ?? data.meetingID));
      if (!mID) return;

      const isMuted = !!(data && data.isMuted);
      await meetingMuteStates.set(mID, socket.alanyaID, isMuted);

      socket.to(`meeting_${mID}`).emit('meeting:mute_state', {
        meetingID: mID,
        userId:    String(socket.alanyaID),
        isMuted,
      });
    } catch (error) {
      console.error('[Socket meeting:mute_state]', error.message);
    }
  });
};

// État caméra : diffuse à tous les autres participants de la réunion.
// Symétrique de meeting:mute_state. L'émetteur est exclu via `socket.to`.
// Le userId provient de socket.alanyaID (fiable), le meetingID de
// socket.currentMeetingID en priorité.
const meetingVideoState = (io, socket, userSockets) => {
  socket.on('meeting:video_state', async (data) => {
    try {
      if (!socket.authenticated) return;
      const mID = socket.currentMeetingID
        || toInt(data && (data.meetingId ?? data.meetingID));
      if (!mID) return;

      const isVideoOff = !!(data && data.isVideoOff);
      await meetingVideoStates.set(mID, socket.alanyaID, isVideoOff);

      console.log(
        `[Socket meeting:video_state] meeting=${mID} user=${socket.alanyaID} isVideoOff=${isVideoOff}`,
      );

      socket.to(`meeting_${mID}`).emit('meeting:video_state', {
        meetingID:  mID,
        userId:     String(socket.alanyaID),
        isVideoOff,
      });
    } catch (error) {
      console.error('[Socket meeting:video_state]', error.message);
    }
  });
};

module.exports = {
  meetingCreate,
  meetingJoinRoom,     
  meetingJoinRequest,
  meetingJoinAccept,
  meetingJoinDecline,
  meetingStart,
  meetingEnd,
  meetingChat,
  meetingLeave,
  meetingOffer,
  meetingAnswer,
  meetingIceCandidate,
  meetingMuteState,
  meetingVideoState,
};