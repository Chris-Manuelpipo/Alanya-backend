const assert = require('assert');
const {
  shouldSkipDeviceForMessage,
  HEARTBEAT_FRESH_MS,
} = require('./pushDeviceRegistry');

const run = () => {
  const now = Date.now();
  const fresh = new Date(now - 30_000);
  const stale = new Date(now - HEARTBEAT_FRESH_MS - 1000);

  assert.strictEqual(
    shouldSkipDeviceForMessage(
      { appState: 'foreground', activeConversationId: 5, lastHeartbeatAt: fresh },
      5,
    ),
    true,
  );

  assert.strictEqual(
    shouldSkipDeviceForMessage(
      { appState: 'foreground', activeConversationId: 5, lastHeartbeatAt: stale },
      5,
    ),
    false,
  );

  assert.strictEqual(
    shouldSkipDeviceForMessage(
      { appState: 'background', activeConversationId: 5, lastHeartbeatAt: fresh },
      5,
    ),
    false,
  );

  assert.strictEqual(
    shouldSkipDeviceForMessage(
      { appState: 'foreground', activeConversationId: 9, lastHeartbeatAt: fresh },
      5,
    ),
    false,
  );

  console.log('pushDeviceRegistry.test.js: OK');
};

run();
