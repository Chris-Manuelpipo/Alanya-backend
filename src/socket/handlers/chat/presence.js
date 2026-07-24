const pool = require('../../../config/db');
const { emitPresenceUpdate } = require('../../../utils/blockUtils');
const pendingCalls = require('../../state/pendingCalls');
const meetingMuteStates = require('../../state/meetingMuteStates');
const callState = require('../../state/callState');
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

  // Appel actif : on nettoie/arme la grâce quand le DERNIER socket du compte part,
  // OU quand le socket qui se déconnecte est précisément celui engagé dans l'appel
  // (socket.currentCallID, posé côté appelant dans call_user et côté destinataire
  // dans answer_call). Sinon un kill multi-appareil laisserait l'état « in_call »
  // orphelin et l'utilisateur apparaîtrait occupé à tort (false-busy).
  const entry = callState.getEntry(userID);
  const inCallOnThisSocket = socket.currentCallID != null;
  const hasActiveCall =
    !!entry && (entry.status === 'in_call' || entry.status === 'ringing');

  if (hasActiveCall && (lastSocket || inCallOnThisSocket)) {
    try {
      if (entry.status === 'in_call') {
        // Grace period : laisser le temps au client de se reconnecter après kill.
        callState.scheduleDisconnectGrace(userID, async () => {
          try {
            await endActiveCallForUser(io, userSockets, userID, 'disconnect_grace_expired');
          } catch (e) {
            console.warn('[Socket disconnect] grace endActiveCallForUser failed:', e.message);
          }
        });
        console.log(`[Socket disconnect] Grace period armée user=${userID} callId=${entry.callId ?? 'none'}`);
      } else {
        await endActiveCallForUser(io, userSockets, userID, 'disconnect');
      }
    } catch (e) {
      console.warn('[Socket disconnect] endActiveCallForUser failed:', e.message);
    }
  }

  // Rejeu de l'appel entrant en attente : seulement quand le compte est totalement
  // hors-ligne (aucun autre socket pour recevoir l'offre en temps réel).
  if (lastSocket) {
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
