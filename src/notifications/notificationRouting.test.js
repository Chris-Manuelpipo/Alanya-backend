const assert = require('assert');
const { shouldUseDeviceRegistry } = require('./notificationRouting');

// --- message : le cas historique, doit rester inchangé ---
assert.strictEqual(
  shouldUseDeviceRegistry(true, { type: 'message', conversationId: 12 }),
  true,
  'un message avec conversationId passe par le registre',
);

// --- message_read_sync : la correction ---
// Sans elle, la sync de lecture partait sur sendToUserLegacy, donc vers le seul
// users.fcm_token — alors que sa raison d'être est d'atteindre les AUTRES
// appareils du compte pour qu'ils retirent leur notification.
assert.strictEqual(
  shouldUseDeviceRegistry(true, { type: 'message_read_sync', conversationId: 12 }),
  true,
  'une sync de lecture avec conversationId passe par le registre',
);
assert.strictEqual(
  shouldUseDeviceRegistry(true, { type: 'message_read_sync', conversationId: '12' }),
  true,
  'conversationId stringifié (payload FCM) accepté',
);

// --- conversationId absent ou nul : resolvePushTargets ne saurait pas quel
// appareil écarter, on retombe sur le chemin legacy ---
for (const data of [
  { type: 'message_read_sync' },
  { type: 'message_read_sync', conversationId: null },
  { type: 'message_read_sync', conversationId: '' },
  { type: 'message_read_sync', conversationId: 0 },
  { type: 'message', conversationId: undefined },
]) {
  assert.strictEqual(
    shouldUseDeviceRegistry(true, data),
    false,
    `sans conversationId exploitable → legacy (${JSON.stringify(data)})`,
  );
}

// --- les autres types restent sur le chemin legacy ---
for (const type of ['call', 'call_ended', 'status_view', 'meeting_invite', undefined]) {
  assert.strictEqual(
    shouldUseDeviceRegistry(true, { type, conversationId: 12 }),
    false,
    `type ${type} → legacy`,
  );
}

// --- le drapeau reste souverain (rollback DEVICE_REGISTRY_V2=false) ---
assert.strictEqual(
  shouldUseDeviceRegistry(false, { type: 'message', conversationId: 12 }),
  false,
  'flag off → legacy même pour un message',
);
assert.strictEqual(
  shouldUseDeviceRegistry(false, { type: 'message_read_sync', conversationId: 12 }),
  false,
  'flag off → legacy même pour une sync de lecture',
);

// --- pas d'exception sur un appel sans argument ---
assert.strictEqual(shouldUseDeviceRegistry(true), false, 'data par défaut → legacy');

console.log('notificationRouting.test.js OK');
