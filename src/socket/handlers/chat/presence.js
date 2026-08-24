const pool = require('../../../config/db');
const { emitPresenceUpdate } = require('../../../utils/blockUtils');
const pendingCalls = require('../../state/pendingCalls');
const meetingMuteStates = require('../../state/meetingMuteStates');
const callState = require('../../state/callState');
const { endActiveCallForUser, cleanupGroupRoomOnDisconnect } = require('../calls');
const callDeviceOwnership = require('../../state/callDeviceOwnership');
const meetingDevicePresence = require('../../state/meetingDevicePresence');
const { normalizeDeviceId } = require('../../../utils/deviceId');
const {
  unregisterUserSocket,
  hasForegroundSocket,
} = require('../../../utils/userSocketRegistry');

/**
 * Dernier état diffusé par utilisateur, pour ne pas réécrire en base ni
 * rediffuser quand rien n'a changé. `emitPresenceUpdate` cible désormais les
 * seuls co-participants/contacts, mais chaque diffusion coûte quand même
 * 2-3 requêtes : ce garde-fou reste nécessaire.
 */
const _lastBroadcast = new Map();

/**
 * Recalcule la présence d'un compte à partir de ses sockets et diffuse le
 * changement s'il y en a un.
 *
 * « En ligne » ⇔ au moins une socket du compte se déclare au premier plan.
 * Une socket ouverte ne suffit pas : l'app la garde en arrière-plan pour
 * continuer à recevoir messages et appels.
 */
const syncPresence = async (io, alanyaID) => {
  const uid = Number(alanyaID);
  if (!uid) return;

  const online = await hasForegroundSocket(io, uid);
  if (_lastBroadcast.get(uid) === online) return;
  _lastBroadcast.set(uid, online);

  const lastSeen = new Date();
  try {
    // is_online/last_seen vivent dans user_presence, pas `users` (audit
    // scalabilité, fractionnement par colonnes — la contention avec le
    // FOR UPDATE de materializeForUser disparaît puisque cette écriture ne
    // touche plus la ligne `users`).
    await pool.execute(
      `INSERT INTO user_presence (alanyaID, is_online, last_seen) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE is_online = VALUES(is_online), last_seen = VALUES(last_seen)`,
      [uid, online ? 1 : 0],
    );
  } catch (e) {
    console.error('[Socket presence] DB update failed:', e.code || '', e.message);
  }

  await emitPresenceUpdate(io, uid, {
    userID: uid,
    online,
    lastSeen: lastSeen.toISOString(),
  });

  // Compte totalement déconnecté : ne pas garder d'entrée résiduelle.
  if (!online && !io.sockets.adapter.rooms.get(`user_${uid}`)) {
    _lastBroadcast.delete(uid);
  }
};

const presenceOnline = (io, socket) => {
  socket.on('presence:online', async () => {
    // On ignore le `userID` fourni par le client : seul le JWT fait foi,
    // sinon n'importe quelle socket pourrait mettre n'importe qui en ligne.
    if (!socket.authenticated || !socket.alanyaID) return;
    socket.isForeground = true;
    socket.data.isForeground = true; // doublé pour fetchSockets() cross-instance
    await syncPresence(io, socket.alanyaID);
  });
};

const presenceOffline = (io, socket) => {
  socket.on('presence:offline', async () => {
    if (!socket.authenticated || !socket.alanyaID) return;
    // Passer en arrière-plan n'est PAS une déconnexion : la socket reste
    // enregistrée (routage des appels, réception des messages), seul son
    // drapeau premier plan tombe.
    socket.isForeground = false;
    socket.data.isForeground = false; // doublé pour fetchSockets() cross-instance
    await syncPresence(io, socket.alanyaID);
  });
};

const handleDisconnect = async (io, socket, userSockets) => {
  const userID = socket.alanyaID;
  if (!userID) return;

  const lastSocket = unregisterUserSocket(userSockets, userID, socket.id);

  // Appel actif : impact média seulement si ce socket/device est propriétaire,
  // ou dernier socket du compte sans ownership (legacy).
  const entry = callState.getEntry(userID);
  const callKey = entry?.callId != null ? String(entry.callId) : null;
  const deviceId = normalizeDeviceId(socket.deviceId);
  const isMediaOwner = callKey
    ? (callDeviceOwnership.isOwnerDevice(callKey, userID, deviceId)
      || callDeviceOwnership.isOwnerSocket(callKey, userID, socket.id)
      || !callDeviceOwnership.getActiveDeviceId(callKey, userID))
    : (socket.currentCallID != null);
  const hasActiveCall =
    !!entry && (entry.status === 'in_call' || entry.status === 'ringing');

  if (hasActiveCall && isMediaOwner && (lastSocket || socket.currentCallID != null)) {
    try {
      if (entry.status === 'in_call') {
        callState.scheduleDisconnectGrace(userID, async () => {
          try {
            await endActiveCallForUser(io, userSockets, userID, 'disconnect_grace_expired');
            if (callKey) callDeviceOwnership.release(callKey);
          } catch (e) {
            console.warn('[Socket disconnect] grace endActiveCallForUser failed:', e.message);
          }
        });
        console.log(`[Socket disconnect] Grace period armée user=${userID} callId=${entry.callId ?? 'none'}`);
      } else {
        callState.scheduleRingingDisconnectGrace(userID, async () => {
          try {
            await endActiveCallForUser(io, userSockets, userID, 'ringing_disconnect_grace_expired');
            if (callKey) callDeviceOwnership.release(callKey);
          } catch (e) {
            console.warn('[Socket disconnect] ringing grace endActiveCallForUser failed:', e.message);
          }
        });
        console.log(`[Socket disconnect] Grâce sonnerie armée user=${userID} callId=${entry.callId ?? 'none'}`);
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

  // Appel de groupe : symétrique du bloc meetings ci-dessous. Sans lui, un
  // crash d'app en plein appel laissait un participant fantôme à vie.
  cleanupGroupRoomOnDisconnect(io, socket);

  const meetingID = socket.currentMeetingID;
  if (meetingID) {
    const mID = Number(meetingID);
    const isMeetingOwner = meetingDevicePresence.isOwnerDevice(mID, userID, deviceId)
      || !meetingDevicePresence.getActiveDeviceId(mID, userID);

    if (isMeetingOwner) {
      meetingDevicePresence.armDisconnectGrace(mID, userID, async () => {
        try {
          io.to(`meeting_${meetingID}`).emit('meeting:user_left', {
            meetingID,
            userID: String(userID),
          });
          meetingMuteStates.removeUser(meetingID, userID);
          await pool.execute(
            `UPDATE participant
             SET connecte = 0,
                 duree = TIMESTAMPDIFF(SECOND, start_time, NOW())
             WHERE idMeeting = ? AND IDparticipant = ?`,
            [meetingID, userID],
          );
        } catch (e) {
          console.warn('[Socket disconnect] meeting grace cleanup failed:', e.message);
        }
      });
    }
    socket.currentMeetingID = null;
  }

  // À ce stade la socket a déjà quitté ses rooms : `syncPresence` ne voit que
  // les sockets restantes du compte, et ne passe hors ligne que si aucune
  // d'elles n'est au premier plan.
  await syncPresence(io, userID);
};

module.exports = { presenceOnline, presenceOffline, handleDisconnect, syncPresence };
