/**
 * Registre multi-socket par utilisateur + helpers d'émission via room user_*
 * et rooms account-scoped user_<id>_device_<deviceId>.
 */

const { normalizeDeviceId, deviceRoom } = require('./deviceId');

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

function emitToSocket(io, socketId, event, payload) {
  if (!io || !socketId) return;
  io.to(socketId).emit(event, payload);
}

/**
 * Émet vers la room account-scoped d'un appareil.
 * @returns {boolean} true si room valide et emit tenté
 */
function emitToDevice(io, userId, deviceId, event, payload) {
  if (!io) return false;
  const room = deviceRoom(userId, deviceId);
  if (!room) return false;
  io.to(room).emit(event, payload);
  return true;
}

/**
 * Émet à tous les sockets du compte sauf ceux du device exclu.
 * Primitive primaire pour stopper les appareils frères (CallKit / média).
 * Cross-instance via fetchSockets() — voir commentaire ci-dessous.
 */
async function emitToUserExceptDevice(io, userId, excludedDeviceId, event, payload) {
  if (!io || userId == null) return;
  const excluded = normalizeDeviceId(excludedDeviceId);
  let sockets;
  try {
    sockets = await io.in(`user_${Number(userId)}`).fetchSockets();
  } catch (e) {
    console.error('[userSocketRegistry] emitToUserExceptDevice fetchSockets échoué:', e.message);
    return;
  }
  for (const s of sockets) {
    const did = normalizeDeviceId(s.data?.deviceId);
    if (excluded && did && did === excluded) continue;
    s.emit(event, payload);
  }
}

/**
 * `io.sockets.adapter.rooms`/`io.sockets.sockets` ne sont visibles que dans
 * CE process. Même avec l'adapter Redis attaché, ils ne reflètent jamais les
 * sockets connectées à une autre instance : ce sont ces 5 fonctions qu'il
 * faut faire passer par `io.in(room).fetchSockets()` (async, cross-instance)
 * pour rester correctes en multi-instance. Seul `socket.data.*` est
 * sérialisé par l'adapter vers un `RemoteSocket` distant — les propriétés à
 * plat (`socket.isForeground`, `.deviceId`, `.appareilId`) restent posées en
 * plus, pour le code non migré qui les lit localement (voir auth.js/presence.js).
 */
async function isUserOnline(io, alanyaID) {
  if (!io) return false;
  try {
    const sockets = await io.in(`user_${Number(alanyaID)}`).fetchSockets();
    return sockets.length > 0;
  } catch (e) {
    console.error('[userSocketRegistry] isUserOnline fetchSockets échoué:', e.message);
    return false;
  }
}

/**
 * Vrai si AU MOINS UNE socket du compte se déclare au premier plan.
 */
async function hasForegroundSocket(io, alanyaID) {
  if (!io) return false;
  try {
    const sockets = await io.in(`user_${Number(alanyaID)}`).fetchSockets();
    return sockets.some((s) => s.data?.isForeground === true);
  } catch (e) {
    console.error('[userSocketRegistry] hasForegroundSocket fetchSockets échoué:', e.message);
    return false;
  }
}

/**
 * Ferme les sockets d'un appareil précis, à sa révocation — cross-instance :
 * sans passer par fetchSockets(), un appareil révoqué resterait connecté sur
 * toute autre instance que celle ayant traité la requête de révocation.
 * @returns {number} nombre de sockets fermées
 */
async function disconnectAppareilSockets(io, alanyaID, appareilId) {
  if (!io || appareilId == null) return 0;
  let sockets;
  try {
    sockets = await io.in(`user_${Number(alanyaID)}`).fetchSockets();
  } catch (e) {
    console.error('[userSocketRegistry] disconnectAppareilSockets fetchSockets échoué:', e.message);
    return 0;
  }
  let closed = 0;
  for (const s of sockets) {
    if (s.data?.appareilId != null && Number(s.data.appareilId) === Number(appareilId)) {
      s.disconnect(true);
      closed++;
    }
  }
  return closed;
}

/** deviceId normalisés des sockets authentifiés dans user_{alanyaID}. */
async function getConnectedDeviceIds(io, alanyaID) {
  const ids = new Set();
  if (!io) return ids;
  let sockets;
  try {
    sockets = await io.in(`user_${Number(alanyaID)}`).fetchSockets();
  } catch (e) {
    console.error('[userSocketRegistry] getConnectedDeviceIds fetchSockets échoué:', e.message);
    return ids;
  }
  for (const s of sockets) {
    const did = normalizeDeviceId(s.data?.deviceId);
    if (did) ids.add(did);
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
  emitToSocket,
  emitToDevice,
  emitToUserExceptDevice,
  isUserOnline,
  getConnectedDeviceIds,
  disconnectAppareilSockets,
  deviceRoom,
  normalizeDeviceId,
};
