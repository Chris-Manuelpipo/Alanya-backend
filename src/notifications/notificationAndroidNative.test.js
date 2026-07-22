/**
 * Tests Phase 4 — push data-only Android quand NOTIFICATION_ANDROID_NATIVE_V2 actif.
 */
const assert = require('assert');

// Simule la branche notificationService (sans Firebase réel).
const shouldUseAndroidNativeDataOnly = (flags, platform, type) => {
  const ANDROID_NATIVE_V2 = flags.ANDROID_NATIVE_V2 === true;
  const plat = String(platform || 'unknown').toLowerCase();
  return ANDROID_NATIVE_V2 && plat === 'android' && type === 'message';
};

assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: true }, 'android', 'message'),
  true,
);
assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: true }, 'ios', 'message'),
  false,
);
assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: false }, 'android', 'message'),
  false,
);
assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: true }, 'android', 'call'),
  false,
);

console.log('notificationAndroidNative.test.js OK');
