/**
 * Token stale — hashing logs + règle de clear voipToken.
 */
const assert = require('assert');
const { hashForLog, logTokenStale } = require('./notificationLogger');

const shouldClearVoipOnStale = (reason) =>
  reason === 'stale_token' || /Unregistered|BadDeviceToken|ExpiredToken/i.test(String(reason || ''));

const clearVoipTokenInMemory = (devices, alanyaID, deviceId) => {
  const d = devices.find(
    (x) => Number(x.alanyaID) === Number(alanyaID) && String(x.deviceId) === String(deviceId),
  );
  if (!d) return false;
  d.voipToken = null;
  return true;
};

// hash never returns raw token
const token = 'super-secret-voip-token-abcdefgh';
const h = hashForLog(token);
assert.strictEqual(h.length, 12);
assert.ok(!h.includes('secret'));
assert.notStrictEqual(h, token);

// clear rule
assert.strictEqual(shouldClearVoipOnStale('stale_token'), true);
assert.strictEqual(shouldClearVoipOnStale('Unregistered'), true);
assert.strictEqual(shouldClearVoipOnStale('network_error'), false);

const devices = [
  { alanyaID: 1, deviceId: 'ios-a', voipToken: 'tok1', fcmToken: 'fcm1' },
];
assert.strictEqual(clearVoipTokenInMemory(devices, 1, 'ios-a'), true);
assert.strictEqual(devices[0].voipToken, null);
assert.strictEqual(devices[0].fcmToken, 'fcm1');

// logTokenStale must not throw
logTokenStale({ type: 'call', reason: 'apns_voip_410', deviceId: hashForLog('ios-a') });

console.log('notificationTokenStale.test.js OK');
