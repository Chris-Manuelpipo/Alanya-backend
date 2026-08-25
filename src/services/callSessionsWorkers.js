/**
 * Exécuteurs des trois délais des sessions d'appel à trois, armés par
 * src/socket/state/callSessions.js (chemin Redis uniquement — le repli mémoire
 * garde ses vrais setTimeout). Calqué sur tripWorkers.js / callStateWorkers.js /
 * meetingWorkers.js.
 *
 * Aucune revalidation à ajouter ici : les trois cascades la portent déjà
 * nativement. `failInvite` sort si la session n'a plus d'invité en attente,
 * `onTransferMediaNotReady` si l'état n'est plus `joined`, `onTransferAutoLeave`
 * si l'état n'est plus `armed`. C'est exactement la garde qu'il faut, un job
 * déjà verrouillé par le worker ne pouvant plus être annulé.
 */

const { registerJobHandler } = require('./jobQueue');

// Injectés par server.js : les jobs tournent hors de toute requête, ils n'ont
// donc accès ni à req.app.get('io') ni au registre de sockets du module.
let _io = null;
let _userSockets = null;
const setIo = (io) => { _io = io; };
const setUserSockets = (userSockets) => { _userSockets = userSockets; };

function registerCallSessionsJobHandlers() {
  // require() tardif : calls.js require callSessions, pas ce module — pas de
  // cycle, mais différer évite tout ordre de chargement fragile au démarrage.
  registerJobHandler('callsession_no_answer', async ({ sessionId }) => {
    const { failInvite } = require('../socket/handlers/calls');
    await failInvite(_io, sessionId, 'no_answer');
  });

  registerJobHandler('callsession_ready_timeout', async ({ sessionId }) => {
    const { onTransferMediaNotReady } = require('../socket/handlers/calls');
    await onTransferMediaNotReady(_io, _userSockets, sessionId);
  });

  registerJobHandler('callsession_auto_leave', async ({ sessionId }) => {
    const { onTransferAutoLeave } = require('../socket/handlers/calls');
    await onTransferAutoLeave(_io, _userSockets, sessionId);
  });
}

module.exports = { setIo, setUserSockets, registerCallSessionsJobHandlers };
