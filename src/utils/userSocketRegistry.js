/**
 * Registre multi-socket par utilisateur + helpers d'émission via room user_*.
 */

function createUserSocketRegistry() {
  return new Map();
}

function registerUserSocket(registry, alanyaID, socketId) {
  const id = Number(alanyaID);
  if (!id || !socketId) return;
  let set = registry.get(id);
  if (!set) {
    set = new Set();
    registry.set(id, set);
  }
  set.add(socketId);
}

/** @returns {boolean} true si c'était le dernier socket de cet utilisateur */
function unregisterUserSocket(registry, alanyaID, socketId) {
  const id = Number(alanyaID);
  if (!id) return true;
  const set = registry.get(id);
  if (!set) return true;
  set.delete(socketId);
  if (set.size === 0) {
    registry.delete(id);
    return true;
  }
  return false;
}

function hasUserSockets(registry, alanyaID) {
  const set = registry.get(Number(alanyaID));
  return !!(set && set.size > 0);
}

function emitToUser(io, alanyaID, event, payload) {
  if (!io || alanyaID == null) return;
  io.to(`user_${Number(alanyaID)}`).emit(event, payload);
}

function isUserOnline(io, alanyaID) {
  if (!io?.sockets?.adapter?.rooms) return false;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  return !!(room && room.size > 0);
}

/**
 * Vrai si AU MOINS UNE socket du compte se déclare au premier plan.
 *
 * C'est la définition de la présence « en ligne » : une socket ouverte ne
 * suffit pas (l'app peut être en arrière-plan tout en gardant sa socket), il
 * faut que le client l'ait explicitement signalé via `presence:online`.
 * L'agrégation sur toute la room gère le multi-appareil : un téléphone qui
 * passe en arrière-plan ne doit pas éteindre la présence si la tablette est
 * encore active.
 */
function hasForegroundSocket(io, alanyaID) {
  if (!io?.sockets?.adapter?.rooms) return false;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return false;
  for (const sid of room) {
    if (io.sockets.sockets.get(sid)?.isForeground === true) return true;
  }
  return false;
}

/**
 * Ferme les sockets d'un appareil précis, à sa révocation.
 *
 * L'event `auth:device_revoked` demande au client de se déconnecter lui-même ;
 * ceci ne dépend pas de sa coopération. Sans cette fermeture, un appareil
 * révoqué continuerait de recevoir messages, appels et présence en temps réel
 * tant qu'il garde sa socket ouverte — la révocation ne mordrait que sur REST.
 *
 * La clé est `appareilId` (porté par le JWT), pas `device_id` : les sockets
 * s'authentifient avec l'UUID applicatif du client, distinct de l'identifiant
 * matériel stocké dans `appareils.device_id`.
 *
 * @returns {number} nombre de sockets fermées
 */
function disconnectAppareilSockets(io, alanyaID, appareilId) {
  if (!io?.sockets?.adapter?.rooms || appareilId == null) return 0;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return 0;
  let closed = 0;
  // Copie : `disconnect` retire la socket de la room pendant l'itération.
  for (const sid of [...room]) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.appareilId != null && Number(s.appareilId) === Number(appareilId)) {
      s.disconnect(true);
      closed++;
    }
  }
  return closed;
}

/** device_id des sockets authentifiés dans user_{alanyaID}. */
function getConnectedDeviceIds(io, alanyaID) {
  const ids = new Set();
  if (!io?.sockets?.adapter?.rooms) return ids;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return ids;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    const did = s?.deviceId;
    if (did && did !== 'INDEFINI') ids.add(String(did));
  }
  return ids;
}

module.exports = {
  createUserSocketRegistry,
  registerUserSocket,
  unregisterUserSocket,
  hasUserSockets,
  hasForegroundSocket,
  emitToUser,
  isUserOnline,
  getConnectedDeviceIds,
  disconnectAppareilSockets,
};
