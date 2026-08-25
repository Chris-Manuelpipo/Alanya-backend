/**
 * Exécuteur de la grâce de déconnexion en réunion armée par
 * src/socket/state/meetingDevicePresence.js (chemin Redis uniquement — le
 * repli mémoire garde son vrai setTimeout). Calqué sur tripWorkers.js /
 * callStateWorkers.js : mêmes conventions (setIo, kind, dedupe,
 * registerJobHandler).
 *
 * La cascade elle-même (`runMeetingDisconnectCascade`) est exportée et
 * partagée : le repli mémoire la passe en `onExpire` à armDisconnectGrace,
 * le chemin Redis l'appelle depuis le handler. Une seule implémentation pour
 * les deux, plutôt qu'une closure dupliquée dans presence.js.
 */

const pool = require('../config/db');
const { registerJobHandler } = require('./jobQueue');
const meetingDevicePresence = require('../socket/state/meetingDevicePresence');
const meetingMuteStates = require('../socket/state/meetingMuteStates');
const meetingVideoStates = require('../socket/state/meetingVideoStates');

// Injecté par server.js : les jobs tournent hors de toute requête, ils n'ont
// donc pas accès à req.app.get('io').
let _io = null;
const setIo = (io) => { _io = io; };

/**
 * Libère la place du participant : prévient la room, purge ses états
 * micro/caméra, et solde sa ligne `participant`.
 *
 * L'appel à `meetingVideoStates.removeUser` corrige une asymétrie
 * pré-existante : seul l'état micro était nettoyé ici, alors que
 * `meeting:leave` (départ explicite) nettoyait bien les deux — un participant
 * parti par expiration de grâce gardait donc son état caméra jusqu'à la fin
 * de la réunion.
 */
async function runMeetingDisconnectCascade(io, meetingID, userID) {
  try {
    if (io) {
      io.to(`meeting_${meetingID}`).emit('meeting:user_left', {
        meetingID,
        userID: String(userID),
      });
    }
    await meetingMuteStates.removeUser(meetingID, userID);
    await meetingVideoStates.removeUser(meetingID, userID);
    await pool.execute(
      `UPDATE participant
       SET connecte = 0,
           duree = TIMESTAMPDIFF(SECOND, start_time, NOW())
       WHERE idMeeting = ? AND IDparticipant = ?`,
      [meetingID, userID],
    );
  } catch (e) {
    console.warn('[Meeting grace] cleanup failed:', e.message);
  }
}

/**
 * Expiration effective d'une grâce.
 *
 * Fonction nommée plutôt que closure inline : la revalidation ci-dessous est
 * la partie la plus délicate du chemin Redis, elle doit rester directement
 * testable sans passer par le worker (voir meetingDevicePresence.race.test.js).
 *
 * @returns {boolean} true si la cascade a réellement été exécutée.
 */
async function handleMeetingDisconnectGrace({ meetingID, userID, graceArmedAt }) {
  // Revalidation obligatoire : un job déjà verrouillé par le worker
  // (SELECT ... FOR UPDATE SKIP LOCKED) ne peut plus être annulé par un
  // cancelByDedupeKey concurrent, contrairement à clearTimeout(). Si
  // l'utilisateur s'est reconnecté entre-temps, tryJoin a remis graceArmedAt
  // à null (ou posé un nouveau jeton) : sortir sans rien faire, sous peine
  // d'éjecter quelqu'un qui vient de revenir.
  const entry = await meetingDevicePresence.get(meetingID, userID);
  if (!entry || entry.graceArmedAt == null || entry.graceArmedAt !== graceArmedAt) {
    return false;
  }
  await meetingDevicePresence.leave(meetingID, userID);
  await runMeetingDisconnectCascade(_io, meetingID, userID);
  return true;
}

function registerMeetingJobHandlers() {
  registerJobHandler('meeting_disconnect_grace', handleMeetingDisconnectGrace);
}

module.exports = {
  setIo,
  registerMeetingJobHandlers,
  runMeetingDisconnectCascade,
  handleMeetingDisconnectGrace,
};
