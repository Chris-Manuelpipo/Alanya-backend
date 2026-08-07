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
 */
function emitToUserExceptDevice(io, userId, excludedDeviceId, event, payload) {
  if (!io || userId == null) return;
  const room = io.sockets?.adapter?.rooms?.get(`user_${Number(userId)}`);
  if (!room) return;
  const excluded = normalizeDeviceId(excludedDeviceId);
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    const did = normalizeDeviceId(s.deviceId);
    if (excluded && did && did === excluded) continue;
    s.emit(event, payload);
  }
}

/**
 * Émet à tous sauf un socketId (actions locales uniquement — pas pour stop CallKit).
 */
function emitToUserExceptSocket(io, userId, exceptSocketId, event, payload) {
  if (!io || userId == null) return;
  const room = io.sockets?.adapter?.rooms?.get(`user_${Number(userId)}`);
  if (!room) return;
  for (const sid of room) {
    if (exceptSocketId && sid === exceptSocketId) continue;
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit(event, payload);
  }
}

function isUserOnline(io, alanyaID) {
  if (!io?.sockets?.adapter?.rooms) return false;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  return !!(room && room.size > 0);
}

/**
 * Vrai si AU MOINS UNE socket du compte se déclare au premier plan.
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
 * @returns {number} nombre de sockets fermées
 */
function disconnectAppareilSockets(io, alanyaID, appareilId) {
  if (!io?.sockets?.adapter?.rooms || appareilId == null) return 0;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return 0;
  let closed = 0;
  for (const sid of [...room]) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.appareilId != null && Number(s.appareilId) === Number(appareilId)) {
      s.disconnect(true);
      closed++;
    }
  }
  return closed;
}

/** deviceId normalisés des sockets authentifiés dans user_{alanyaID}. */
function getConnectedDeviceIds(io, alanyaID) {
  const ids = new Set();
  if (!io?.sockets?.adapter?.rooms) return ids;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return ids;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    const did = normalizeDeviceId(s?.deviceId);
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
  emitToUserExceptSocket,
  isUserOnline,
  getConnectedDeviceIds,
  disconnectAppareilSockets,
  deviceRoom,
  normalizeDeviceId,
};
