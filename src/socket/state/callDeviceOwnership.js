/**
 * Propriété média par appareil pour un appel / session / room.
 * Complète callState / callSessions / pendingCalls (granularité device).
 *
 * Clé : callId | sessionId | roomId (string)
 * Valeur : Map<userId, { activeDeviceId, activeSocketId, claimedAt, state }>
 *
 * states: calling | ringing | active | left
 */

const { normalizeDeviceId } = require('../../utils/deviceId');

const _byKey = new Map(); // key -> Map<userId, entry>

function _key(k) {
  if (k == null || k === '') return null;
  return String(k);
}

function _userMap(key) {
  const k = _key(key);
  if (!k) return null;
  let m = _byKey.get(k);
  if (!m) {
    m = new Map();
    _byKey.set(k, m);
  }
  return m;
}

function getEntry(key, userId) {
  const m = _byKey.get(_key(key));
  if (!m) return null;
  return m.get(Number(userId)) ?? null;
}

function getActiveDeviceId(key, userId) {
  return getEntry(key, userId)?.activeDeviceId ?? null;
}

/**
 * Enregistre le caller au démarrage (call_user).
 */
function setCalling(key, userId, { activeDeviceId, activeSocketId }) {
  const m = _userMap(key);
  if (!m) return false;
  const did = normalizeDeviceId(activeDeviceId);
  if (!did) return false;
  m.set(Number(userId), {
    activeDeviceId: did,
    activeSocketId: activeSocketId ?? null,
    claimedAt: Date.now(),
    state: 'calling',
  });
  return true;
}

/**
 * Callee en sonnerie (pas encore de device actif).
 */
function ring(key, userId) {
  const m = _userMap(key);
  if (!m) return false;
  m.set(Number(userId), {
    activeDeviceId: null,
    activeSocketId: null,
    claimedAt: null,
    state: 'ringing',
  });
  return true;
}

/**
 * Claim atomique : premier device qui gagne.
 * N'invente jamais d'entrée : la session doit exister (ring/setCalling).
 * @returns {{ ok: boolean, reason?: string, entry?: object, alreadyOwner?: boolean }}
 */
function tryClaim(key, userId, deviceId, socketId) {
  const k = _key(key);
  if (!k) return { ok: false, reason: 'NO_SESSION' };
  const m = _byKey.get(k);
  if (!m) return { ok: false, reason: 'NO_SESSION' };
  const uid = Number(userId);
  const did = normalizeDeviceId(deviceId);
  if (!did) return { ok: false, reason: 'DEVICE_ID_REQUIRED' };

  const entry = m.get(uid);
  if (!entry) return { ok: false, reason: 'NO_SESSION' };

  if (entry.state === 'active' && entry.activeDeviceId) {
    if (entry.activeDeviceId === did) {
      entry.activeSocketId = socketId ?? entry.activeSocketId;
      return { ok: true, entry, alreadyOwner: true };
    }
    return { ok: false, reason: 'CALL_ANSWERED_ELSEWHERE', entry };
  }

  if (entry.state === 'left') {
    return { ok: false, reason: 'CALL_LEFT' };
  }

  entry.activeDeviceId = did;
  entry.activeSocketId = socketId ?? null;
  entry.claimedAt = Date.now();
  entry.state = 'active';
  return { ok: true, entry, alreadyOwner: false };
}

function isOwnerDevice(key, userId, deviceId) {
  const did = normalizeDeviceId(deviceId);
  if (!did) return false;
  const entry = getEntry(key, userId);
  return !!(entry && entry.activeDeviceId === did && entry.state !== 'left');
}

function isOwnerSocket(key, userId, socketId) {
  const entry = getEntry(key, userId);
  if (!entry || !socketId) return false;
  return entry.activeSocketId === socketId && entry.state !== 'left';
}

function releaseUser(key, userId) {
  const m = _byKey.get(_key(key));
  if (!m) return;
  const uid = Number(userId);
  const entry = m.get(uid);
  if (entry) {
    entry.state = 'left';
    entry.activeDeviceId = null;
    entry.activeSocketId = null;
  }
}

function release(key) {
  const k = _key(key);
  if (k) _byKey.delete(k);
}

function _reset() {
  _byKey.clear();
}

module.exports = {
  setCalling,
  ring,
  tryClaim,
  getEntry,
  getActiveDeviceId,
  isOwnerDevice,
  isOwnerSocket,
  releaseUser,
  release,
  _reset,
};
