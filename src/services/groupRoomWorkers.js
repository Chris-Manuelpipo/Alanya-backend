/**
 * Expiration des grâces de salon de groupe, exécutée par la file de jobs.
 *
 * Même forme que `meetingWorkers.js` : la cascade est une fonction nommée,
 * exportée, directement testable sans passer par le worker — c'est la partie
 * délicate, elle ne doit pas vivre dans une closure.
 *
 * Ce module ne requiert que `jobQueue` et `groupRooms` : aucun cycle avec
 * `handlers/calls.js`, qui lui en requiert un.
 */

const { registerJobHandler } = require('./jobQueue');
const groupRooms = require('../socket/state/groupRooms');

// Injecté par server.js : les jobs tournent hors de toute requête et n'ont donc
// pas accès à req.app.get('io').
let _io = null;
const setIo = (io) => { _io = io; };

/**
 * Le seul geste visible d'un départ : l'annonce aux autres participants.
 *
 * Le retrait du roster n'est PAS fait ici — `expireGrace` s'en charge dans le
 * même script que la vérification du jeton. Les séparer rouvrirait la fenêtre
 * où un revenant se fait éjecter entre les deux.
 *
 * Ne rappelle pas non plus `callDeviceOwnership.forget` : la libération a déjà
 * eu lieu à la déconnexion, et la refaire ici effacerait l'ownership d'un
 * appareil revenu entre-temps.
 */
async function runGroupLeaveCascade(io, roomID, userID) {
  try {
    if (io) {
      io.to(`group_${roomID}`).emit('group_user_left', {
        roomId: String(roomID),
        userId: String(userID),
      });
    }
  } catch (e) {
    console.warn('[Group grace] cascade échouée:', e.message);
  }
}

/**
 * Échéance d'une grâce.
 *
 * `expireGrace` fait la revalidation ET le retrait en un seul script : un job
 * déjà verrouillé par le worker ne peut plus être annulé — contrairement à un
 * `clearTimeout` — et doit donc pouvoir constater tout seul qu'il n'a plus lieu
 * d'être. `consomme:false` couvre le retour du participant, son départ
 * volontaire, la fin du salon, et le rejeu du même job.
 *
 * Cas connu et assumé : une autre socket vivante du même compte peut encore
 * être dans la salle (service au premier plan, CallKit). La grâce l'éjectera
 * quand même. Les blocs 1-à-1 et réunion partagent ce défaut ; le corriger
 * demanderait un `fetchSockets` par échéance, qui échoue en silence sans
 * adaptateur.
 *
 * @returns {boolean} true si la cascade a réellement été exécutée.
 */
async function handleGroupRoomDisconnectGrace({ roomID, userID, jeton }) {
  const r = await groupRooms.expireGrace(roomID, userID, String(jeton));
  if (!r.consomme) return false;
  await runGroupLeaveCascade(_io, roomID, userID);
  return true;
}

function registerGroupRoomJobHandlers() {
  registerJobHandler(groupRooms.GRACE_KIND, handleGroupRoomDisconnectGrace);
}

module.exports = {
  setIo,
  registerGroupRoomJobHandlers,
  runGroupLeaveCascade,
  handleGroupRoomDisconnectGrace,
};
