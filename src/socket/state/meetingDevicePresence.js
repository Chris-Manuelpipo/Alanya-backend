/**
 * Présence live meeting par appareil (distincte de la table SQL participant).
 * meetingId -> Map<userId, { activeDeviceId, activeSocketId, joinedAt, reconnectGraceTimer }>
 */

const { normalizeDeviceId } = require('../../utils/deviceId');

const OWNER_GRACE_MS = 15 * 1000;
const _byMeeting = new Map();

function _mid(meetingId) {
  const n = Number(meetingId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function get(meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return null;
  return _byMeeting.get(mid)?.get(Number(userId)) ?? null;
}

/**
 * @returns {{ ok: true, resumed?: boolean } | { ok: false, code: string }}
 */
function tryJoin(meetingId, userId, deviceId, socketId) {
  const mid = _mid(meetingId);
  const uid = Number(userId);
  const did = normalizeDeviceId(deviceId);
  if (!mid || !uid) return { ok: false, code: 'INVALID' };
  if (!did) return { ok: false, code: 'DEVICE_ID_REQUIRED' };

  let m = _byMeeting.get(mid);
  if (!m) {
    m = new Map();
    _byMeeting.set(mid, m);
  }

  const existing = m.get(uid);
  if (existing?.reconnectGraceTimer) {
    clearTimeout(existing.reconnectGraceTimer);
    existing.reconnectGraceTimer = null;
  }

  if (existing && existing.activeDeviceId && existing.activeDeviceId !== did) {
    return { ok: false, code: 'ACCOUNT_ALREADY_IN_MEETING' };
  }

  const resumed = !!(existing && existing.activeDeviceId === did);
  m.set(uid, {
    activeDeviceId: did,
    activeSocketId: socketId ?? null,
    joinedAt: existing?.joinedAt ?? Date.now(),
    reconnectGraceTimer: null,
  });
  return { ok: true, resumed };
}

function leave(meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  const m = _byMeeting.get(mid);
  if (!m) return;
  const uid = Number(userId);
  const entry = m.get(uid);
  if (entry?.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
  m.delete(uid);
  if (m.size === 0) _byMeeting.delete(mid);
}

/**
 * Arme une grâce avant de libérer la place (disconnect owner).
 * @param {() => void} onExpire
 */
function armDisconnectGrace(meetingId, userId, onExpire, ms = OWNER_GRACE_MS) {
  const entry = get(meetingId, userId);
  if (!entry) return null;
  if (entry.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
  entry.reconnectGraceTimer = setTimeout(() => {
    entry.reconnectGraceTimer = null;
    leave(meetingId, userId);
    if (typeof onExpire === 'function') onExpire();
  }, ms);
  return entry.reconnectGraceTimer;
}

function cancelDisconnectGrace(meetingId, userId) {
  const entry = get(meetingId, userId);
  if (!entry?.reconnectGraceTimer) return;
  clearTimeout(entry.reconnectGraceTimer);
  entry.reconnectGraceTimer = null;
}

function isOwnerDevice(meetingId, userId, deviceId) {
  const did = normalizeDeviceId(deviceId);
  if (!did) return false;
  const entry = get(meetingId, userId);
  return !!(entry && entry.activeDeviceId === did);
}

function getActiveDeviceId(meetingId, userId) {
  return get(meetingId, userId)?.activeDeviceId ?? null;
}

function clearMeeting(meetingId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  const m = _byMeeting.get(mid);
  if (!m) return;
  for (const entry of m.values()) {
    if (entry.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
  }
  _byMeeting.delete(mid);
}

function _reset() {
  for (const m of _byMeeting.values()) {
    for (const entry of m.values()) {
      if (entry.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
    }
  }
  _byMeeting.clear();
}

module.exports = {
  OWNER_GRACE_MS,
  get,
  tryJoin,
  leave,
  armDisconnectGrace,
  cancelDisconnectGrace,
  isOwnerDevice,
  getActiveDeviceId,
  clearMeeting,
  _reset,
};
