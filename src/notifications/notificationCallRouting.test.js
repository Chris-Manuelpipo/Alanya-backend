/**
 * Tests de routage appels (VoIP vs FCM) — sans appels réseau réels.
 * Extrait la logique de décision pour validation unitaire.
 */
const assert = require('assert');

const decideCallPushChannel = ({
  iosVoipEnabled,
  platform,
  voipToken,
  voipConfigured,
  fcmToken,
}) => {
  const plat = String(platform || 'unknown').toLowerCase();
  const voip = String(voipToken || '').trim();
  const fcm = String(fcmToken || '').trim();
  const channels = [];

  if (iosVoipEnabled && plat === 'ios' && voip && voipConfigured) {
    channels.push('voip');
  }
  if (fcm && fcm !== 'INDEFINI') {
    // Entrant : FCM seulement si VoIP n'a pas déjà envoyé (fallback).
    // call_ended : FCM toujours (en plus du VoIP dismiss).
    channels.push('fcm');
  }
  return channels;
};

const decideCallEndedChannels = ({
  iosVoipEnabled,
  platform,
  voipToken,
  voipConfigured,
  fcmToken,
}) => {
  const plat = String(platform || 'unknown').toLowerCase();
  const voip = String(voipToken || '').trim();
  const fcm = String(fcmToken || '').trim();
  const channels = [];
  if (iosVoipEnabled && plat === 'ios' && voip && voipConfigured) {
    channels.push('voip');
  }
  if (fcm && fcm !== 'INDEFINI') {
    channels.push('fcm');
  }
  return channels;
};

const decideIncomingChannels = (opts) => {
  const all = decideCallPushChannel(opts);
  // Incoming: prefer VoIP alone when it succeeds; FCM is fallback only.
  if (all.includes('voip')) return ['voip'];
  return all.filter((c) => c === 'fcm');
};

// Incoming iOS VoIP configured → voip only
assert.deepStrictEqual(
  decideIncomingChannels({
    iosVoipEnabled: true,
    platform: 'ios',
    voipToken: 'abc',
    voipConfigured: true,
    fcmToken: 'fcm1',
  }),
  ['voip'],
);

// Incoming iOS VoIP off → FCM fallback
assert.deepStrictEqual(
  decideIncomingChannels({
    iosVoipEnabled: false,
    platform: 'ios',
    voipToken: 'abc',
    voipConfigured: true,
    fcmToken: 'fcm1',
  }),
  ['fcm'],
);

// Incoming Android → FCM
assert.deepStrictEqual(
  decideIncomingChannels({
    iosVoipEnabled: true,
    platform: 'android',
    voipToken: '',
    voipConfigured: true,
    fcmToken: 'fcm1',
  }),
  ['fcm'],
);

// call_ended iOS → voip + fcm
assert.deepStrictEqual(
  decideCallEndedChannels({
    iosVoipEnabled: true,
    platform: 'ios',
    voipToken: 'abc',
    voipConfigured: true,
    fcmToken: 'fcm1',
  }),
  ['voip', 'fcm'],
);

// Stale / empty tokens → no channel
assert.deepStrictEqual(
  decideIncomingChannels({
    iosVoipEnabled: true,
    platform: 'ios',
    voipToken: '',
    voipConfigured: true,
    fcmToken: 'INDEFINI',
  }),
  [],
);

console.log('notificationCallRouting.test.js OK');
