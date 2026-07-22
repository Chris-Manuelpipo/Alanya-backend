/**
 * Tests Phase 4 — push data-only Android quand NOTIFICATION_ANDROID_NATIVE_V2 actif.
 */
const assert = require('assert');
const { shouldUseAndroidNativeDataOnly } = require('./notificationAndroidNative');

assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: true }, 'android', 'message'),
  true,
);
assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: true }, 'unknown', 'message'),
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
assert.strictEqual(
  shouldUseAndroidNativeDataOnly({ ANDROID_NATIVE_V2: true }, 'web', 'message'),
  false,
);

console.log('notificationAndroidNative.test.js OK');
