/**
 * Identifiant d'appareil canonique partagé :
 * Flutter ensureStableDeviceId() = socket.deviceId = user_push_devices.deviceId
 * = segment device de deviceRoom(userId, deviceId).
 */

const DEVICE_ID_MAX_LEN = 128;

/**
 * @param {unknown} raw
 * @returns {string|null} id normalisé, ou null si invalide / INDEFINI
 */
function normalizeDeviceId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === 'INDEFINI') return null;
  return s.slice(0, DEVICE_ID_MAX_LEN);
}

/**
 * Room Socket.IO account-scoped (jamais globale device_<id>).
 * @returns {string|null}
 */
function deviceRoom(userId, deviceId) {
  const uid = Number(userId);
  const did = normalizeDeviceId(deviceId);
  if (!uid || !did) return null;
  return `user_${uid}_device_${did}`;
}

module.exports = {
  DEVICE_ID_MAX_LEN,
  normalizeDeviceId,
  deviceRoom,
};
