/**
 * Push messages Android natif (TalkyFirebaseMessagingService) — data-only FCM.
 * Sans bloc `notification`, onMessageReceived s'exécute en arrière-plan et
 * MessagingStyle empile les messages. Avec le bloc, Android auto-affiche et
 * remplace le corps sans appeler le service natif.
 */
const shouldUseAndroidNativeDataOnly = (flags, platform, type) => {
  if (!flags.ANDROID_NATIVE_V2 || type !== 'message') return false;
  const plat = String(platform || 'unknown').toLowerCase();
  // `unknown` = fallback legacy users.fcm_token (souvent Android) — iOS garde APNS alert.
  return plat === 'android' || plat === 'unknown';
};

module.exports = {
  shouldUseAndroidNativeDataOnly,
};
