const pool = require('../../../config/db');
const { emitPresenceUpdate } = require('../../../utils/blockUtils');
const pendingCalls = require('../../state/pendingCalls');
const meetingMuteStates = require('../../state/meetingMuteStates');
const callState = require('../../state/callState');
const { endActiveCallForUser } = require('../calls');
const {
  unregisterUserSocket,
  hasForegroundSocket,
} = require('../../../utils/userSocketRegistry');

/**
 * Dernier état diffusé par utilisateur, pour ne pas réécrire en base ni
 * rediffuser quand rien n'a changé. `emitPresenceUpdate` fait un `io.emit`
 * global : sans ce garde-fou, chaque bascule d'app d'un seul utilisateur
 * inonderait tous les clients connectés.
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

  const online = hasForegroundSocket(io, uid);
  if (_lastBroadcast.get(uid) === online) return;
  _lastBroadcast.set(uid, online);

  const lastSeen = new Date();
  try {
    await pool.execute(
      'UPDATE users SET is_online = ?, last_seen = NOW() WHERE alanyaID = ?',
      [online ? 1 : 0, uid],
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
    await syncPresence(io, socket.alanyaID);
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

  // À ce stade la socket a déjà quitté ses rooms : `syncPresence` ne voit que
  // les sockets restantes du compte, et ne passe hors ligne que si aucune
  // d'elles n'est au premier plan.
  await syncPresence(io, userID);
};

module.exports = { presenceOnline, presenceOffline, handleDisconnect, syncPresence };
