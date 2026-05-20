// src/socket/handlers/meetings.js
// meetingJoinRoom est maintenant exporté et DOIT être enregistré dans server.js
const pool = require('../../config/db');

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

async function persistLeaveAndMaybeEnd(meetingID, userID) {
  const mID = toInt(meetingID);
  const uID = toInt(userID);
  if (!mID || !uID) return;

  await pool.execute(
    `UPDATE participant
     SET connecte = 0,
         duree = CASE
                   WHEN start_time IS NULL THEN duree
                   ELSE TIMESTAMPDIFF(SECOND, start_time, NOW())
                 END
     WHERE idMeeting = ? AND IDparticipant = ?`,
    [mID, uID]
  );

  const [connectedRows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM participant
     WHERE idMeeting = ? AND connecte = 1`,
    [mID]
  );

  if ((connectedRows?.[0]?.count ?? 0) === 0) {
    await pool.execute('UPDATE meeting SET isEnd = 1 WHERE idMeeting = ?', [mID]);
    return true;
  }

  return false;
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

// CORRIGÉ : était défini mais jamais exporté ni enregistré dans server.js
const meetingJoinRoom = (io, socket, userSockets) => {
  socket.on('meeting:join_room', (data) => {
    try {
      if (!socket.authenticated) return;
      const { meetingID, userID } = data;
      const mID = toInt(meetingID);
      const uID = toInt(userID) || socket.alanyaID;

      if (!mID) {
        return socket.emit('error', { message: 'meetingID requis' });
      }

      socket.join(`meeting_${mID}`);
      socket.currentMeetingID = mID;

      socket.emit('meeting:room_joined', { meetingID: mID, userID: uID });

      socket.to(`meeting_${mID}`).emit('meeting:user_joined', {
        meetingID: mID,
        userID:    String(uID),
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
  socket.on('meeting:join_accept', (data) => {
    if (!socket.authenticated) return;
    const { meetingID, userID } = data;
    const userSocket = userSockets.get(toInt(userID));

    if (userSocket) {
      io.to(userSocket).emit('meeting:accepted', { meetingID });
    }
    socket.to(`meeting_${meetingID}`).emit('meeting:user_joined', { meetingID, userID });
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
  socket.on('meeting:start', (data) => {
    if (!socket.authenticated) return;
    const { meetingID } = data;
    io.to(`meeting_${meetingID}`).emit('meeting:started', { meetingID });
  });
};

const meetingEnd = (io, socket, userSockets) => {
  socket.on('meeting:end', async (data) => {
    if (!socket.authenticated) return;
    const { meetingID } = data;

    try {
      await pool.execute('UPDATE meeting SET isEnd = 1 WHERE idMeeting = ?', [meetingID]);
      await pool.execute(
        `UPDATE participant
         SET connecte = 0,
             duree = CASE
                       WHEN start_time IS NULL THEN duree
                       ELSE TIMESTAMPDIFF(SECOND, start_time, NOW())
                     END
         WHERE idMeeting = ?`,
        [meetingID]
      );
    } catch (error) {
      console.error('[Socket meeting:end] DB update failed:', error.message);
    }

    io.to(`meeting_${meetingID}`).emit('meeting:ended', { meetingID });

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
      const meetingID = data?.meetingID || socket.currentMeetingID;
      const userID = socket.alanyaID;
      if (!meetingID || !userID) return;

      socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
        meetingID,
        userID: String(userID),
      });

      const ended = await persistLeaveAndMaybeEnd(meetingID, userID);
      if (ended) {
        io.to(`meeting_${meetingID}`).emit('meeting:ended', {
          meetingID: toInt(meetingID),
        });
      }

      socket.leave(`meeting_${meetingID}`);
      socket.currentMeetingID = null;
    } catch (error) {
      console.error('[Socket meeting:leave]', error.message);
    }
  });
};

const meetingHandleDisconnect = async (io, socket) => {
  try {
    const meetingID = socket.currentMeetingID;
    const userID = socket.alanyaID;
    if (!meetingID || !userID) return;

    socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
      meetingID,
      userID: String(userID),
    });

    const ended = await persistLeaveAndMaybeEnd(meetingID, userID);
    if (ended) {
      io.to(`meeting_${meetingID}`).emit('meeting:ended', {
        meetingID: toInt(meetingID),
      });
    }

    socket.currentMeetingID = null;
  } catch (error) {
    console.error('[Socket meeting:disconnect]', error.message);
  }
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

module.exports = {
  meetingCreate,
  meetingJoinRoom,      // ← MAINTENANT EXPORTÉ
  meetingJoinRequest,
  meetingJoinAccept,
  meetingJoinDecline,
  meetingStart,
  meetingEnd,
  meetingChat,
  meetingLeave,
  meetingHandleDisconnect,
  meetingOffer,
  meetingAnswer,
  meetingIceCandidate,
};