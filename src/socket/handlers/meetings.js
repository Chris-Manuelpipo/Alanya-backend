const pool = require('../../config/db');
const meetingMuteStates = require('../state/meetingMuteStates');
const meetingVideoStates = require('../state/meetingVideoStates');

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
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
      const uID = toInt(userID) || socket.alanyaID;

      if (!mID) {
        return socket.emit('error', { message: 'meetingID requis' });
      }

      socket.join(`meeting_${mID}`);
      socket.currentMeetingID = mID;

      if (typeof isMuted === 'boolean') {
        meetingMuteStates.set(mID, uID, isMuted);
      }

      if (typeof isVideoOff === 'boolean') {
        meetingVideoStates.set(mID, uID, isVideoOff);
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
        muteStates: meetingMuteStates.getSnapshot(mID, uID),
        videoStates: meetingVideoStates.getSnapshot(mID, uID),
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
    const userSocket = userSockets.get(uID);

    if (userSocket) {
      io.to(userSocket).emit('meeting:accepted', { meetingID });
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
    const userSocket = userSockets.get(toInt(userID));

    if (userSocket) {
      io.to(userSocket).emit('meeting:declined', { meetingID });
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
    meetingMuteStates.clearMeeting(meetingID);
    meetingVideoStates.clearMeeting(meetingID);

    const roomSockets = io.sockets.adapter.rooms.get(`meeting_${meetingID}`);
    if (roomSockets) {
      for (const sid of roomSockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.leave(`meeting_${meetingID}`);
          s.currentMeetingID = null;
        }
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
  socket.on('meeting:leave', (data) => {
    try {
      const meetingID = data?.meetingID || socket.currentMeetingID;
      if (!meetingID) return;

      socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
        meetingID,
        userID: String(socket.alanyaID),
      });

      meetingMuteStates.removeUser(meetingID, socket.alanyaID);
      meetingVideoStates.removeUser(meetingID, socket.alanyaID);
      socket.leave(`meeting_${meetingID}`);
      socket.currentMeetingID = null;
    } catch (error) {
      console.error('[Socket meeting:leave]', error.message);
    }
  });
};

const meetingOffer = (io, socket, userSockets) => {
  socket.on('meeting:offer', (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, toUserID, offer } = data;
      const targetID = toInt(toUserID);
      if (!targetID || !offer) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('meeting:offer', {
          fromUserID: String(socket.alanyaID),
          offer,
          meetingID,
        });
      }
    } catch (error) {
      console.error('[Socket meeting:offer]', error.message);
    }
  });
};

const meetingAnswer = (io, socket, userSockets) => {
  socket.on('meeting:answer', (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, toUserID, answer } = data;
      const targetID = toInt(toUserID);
      if (!targetID || !answer) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('meeting:answer', {
          fromUserID: String(socket.alanyaID),
          answer,
          meetingID,
        });
      }
    } catch (error) {
      console.error('[Socket meeting:answer]', error.message);
    }
  });
};

const meetingIceCandidate = (io, socket, userSockets) => {
  socket.on('meeting:ice_candidate', (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, toUserID, candidate } = data;
      const targetID = toInt(toUserID);
      if (!targetID || !candidate) return;

      const targetSocketId = userSockets.get(targetID);
      if (targetSocketId) {
        io.to(targetSocketId).emit('meeting:ice_candidate', {
          fromUserID: String(socket.alanyaID),
          candidate,
          meetingID,
        });
      }
    } catch (error) {
      console.error('[Socket meeting:ice_candidate]', error.message);
    }
  });
};

// État micro (mute) : diffuse à tous les autres participants de la réunion.
// L'émetteur est exclu via `socket.to`. Le userId provient de socket.alanyaID
// (fiable), le meetingID de socket.currentMeetingID en priorité.
const meetingMuteState = (io, socket, userSockets) => {
  socket.on('meeting:mute_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const mID = socket.currentMeetingID
        || toInt(data && (data.meetingId ?? data.meetingID));
      if (!mID) return;

      const isMuted = !!(data && data.isMuted);
      meetingMuteStates.set(mID, socket.alanyaID, isMuted);

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
  socket.on('meeting:video_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const mID = socket.currentMeetingID
        || toInt(data && (data.meetingId ?? data.meetingID));
      if (!mID) return;

      const isVideoOff = !!(data && data.isVideoOff);
      meetingVideoStates.set(mID, socket.alanyaID, isVideoOff);

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