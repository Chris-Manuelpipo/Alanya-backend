/**
 * Feature flags notifications — rollout progressif (Phase 7).
 * Variables d'environnement : 'true' | '1' pour activer.
 */

const isEnabled = (name, defaultValue = false) => {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return defaultValue;
  return v === '1' || v === 'true' || v === 'yes';
};

module.exports = {
  ALWAYS_PUSH_MESSAGES: isEnabled('ALWAYS_PUSH_MESSAGES', true),
  DEVICE_REGISTRY_V2: isEnabled('DEVICE_REGISTRY_V2', true),
  ANDROID_NATIVE_V2: isEnabled('NOTIFICATION_ANDROID_NATIVE_V2', false),
  IOS_CATEGORIES_V2: isEnabled('IOS_CATEGORIES_V2', false),
  IOS_VOIP_V2: isEnabled('IOS_VOIP_V2', false),
};
