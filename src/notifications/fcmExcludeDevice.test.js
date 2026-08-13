/**
 * Exclusion FCM excludeDeviceId (filtre pure logique).
 */
const assert = require('assert');
const { normalizeDeviceId } = require('../utils/deviceId');

function filterCallEndedTargets(targets, excludeDeviceIdRaw) {
  const excludeDeviceId = normalizeDeviceId(excludeDeviceIdRaw);
  const out = [];
  for (const target of targets) {
    const targetDid = normalizeDeviceId(target.deviceId);
    if (!targetDid) continue; // ambigu → ne pas envoyer
    if (excludeDeviceId && targetDid === excludeDeviceId) continue;
    out.push(target);
  }
  return out;
}

const targets = [
  { deviceId: 'B1', fcmToken: 't1' },
  { deviceId: 'B2', fcmToken: 't2' },
  { deviceId: 'INDEFINI', fcmToken: 't3' },
  { deviceId: null, fcmToken: 't4' },
];

const filtered = filterCallEndedTargets(targets, 'B1');
assert.deepStrictEqual(
  filtered.map((t) => t.deviceId),
  ['B2'],
);

const none = filterCallEndedTargets(targets, null);
assert.deepStrictEqual(
  none.map((t) => t.deviceId),
  ['B1', 'B2'],
);

console.log('fcmExcludeDevice.test.js OK');
