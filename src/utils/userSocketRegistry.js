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
  emitToUser,
  isUserOnline,
  getConnectedDeviceIds,
};
