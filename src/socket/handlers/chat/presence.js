const pool = require('../../../config/db');
const { emitPresenceUpdate } = require('../../../utils/blockUtils');
const pendingCalls = require('../../state/pendingCalls');
const meetingMuteStates = require('../../state/meetingMuteStates');
const { endActiveCallForUser } = require('../calls');
const {
  registerUserSocket,
  unregisterUserSocket,
} = require('../../../utils/userSocketRegistry');

const presenceOnline = (io, socket, userSockets) => {
  socket.on('presence:online', async (data) => {
    const userID = typeof data === 'object' ? data.userID : data;
    if (!userID) return;

    registerUserSocket(userSockets, Number(userID), socket.id);
    socket.alanyaID = Number(userID);

    try {
      await pool.execute(
        'UPDATE users SET is_online = 1, last_seen = NOW() WHERE alanyaID = ?',
        [userID],
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

    const uid = Number(userID);
    const lastSocket = unregisterUserSocket(userSockets, uid, socket.id);

    if (!lastSocket) return;

    try {
      await pool.execute(
        'UPDATE users SET is_online = 0, last_seen = NOW() WHERE alanyaID = ?',
        [userID],
      );
    } catch (e) {
      console.warn('[Socket presence:offline] DB update failed:', e.message);
    }

    await emitPresenceUpdate(io, userID, {
      userID: uid,
      online: false,
      lastSeen: new Date().toISOString(),
    });
  });
};

const handleDisconnect = async (io, socket, userSockets) => {
  const userID = socket.alanyaID;
  if (!userID) return;

  const lastSocket = unregisterUserSocket(userSockets, userID, socket.id);

  // Appel / pending : uniquement quand le dernier socket du compte part
  // (sinon un 2e appareil déconnecté couperait un appel actif sur le 1er).
  if (lastSocket) {
    try {
      await endActiveCallForUser(io, userSockets, userID, 'disconnect');
    } catch (e) {
      console.warn('[Socket disconnect] endActiveCallForUser failed:', e.message);
    }
    pendingCalls.markUndelivered(userID);
  }

  const meetingID = socket.currentMeetingID;
  if (meetingID) {
    socket.to(`meeting_${meetingID}`).emit('meeting:user_left', {
      meetingID,
      userID: String(userID),
    });
    meetingMuteStates.removeUser(meetingID, userID);
    try {
      await pool.execute(
        `UPDATE participant
         SET connecte = 0,
             duree = TIMESTAMPDIFF(SECOND, start_time, NOW())
         WHERE idMeeting = ? AND IDparticipant = ?`,
        [meetingID, userID],
      );
    } catch (e) {
      console.warn('[Socket disconnect] participant cleanup failed:', e.message);
    }
    socket.currentMeetingID = null;
  }

  if (!lastSocket) return;

  try {
    await pool.execute(
      'UPDATE users SET is_online = 0, last_seen = NOW() WHERE alanyaID = ?',
      [userID],
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

module.exports = { presenceOnline, presenceOffline, handleDisconnect };
