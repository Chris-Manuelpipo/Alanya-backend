const assert = require('assert');
const callState = require('./callState');

// Reset module state between tests (same process).
const reset = async () => {
  await callState.clear(1);
  await callState.clear(2);
  await callState.clear(3);
};

(async () => {
  await reset();
  await callState.setRinging(2, { callId: '100', peerId: 1 });
  assert.strictEqual(await callState.isBusyForNewCall(2, 1), false, 'glare callee');
  assert.strictEqual(await callState.isBusyForNewCall(1, 2), false, 'glare caller');

  await reset();
  await callState.setRinging(2, { callId: '100', peerId: 1 });
  assert.strictEqual(await callState.isBusyForNewCall(2, 3), true, 'busy with other');

  await reset();
  await callState.setRinging(1, { callId: '101', peerId: 2 });
  await callState.setRinging(2, { callId: '101', peerId: 1 });
  const pair = await callState.findExistingRingingPair(1, 2);
  assert.ok(pair);
  assert.strictEqual(pair.callId, '101');

  await reset();
  await callState.setRinging(2, { callId: '102', peerId: 1 });
  const entry = await callState.getEntry(2);
  entry.ringingSince = Date.now() - callState.STALE_RINGING_MS - 1000;
  assert.strictEqual(await callState.isBusyForNewCall(2, 3), false, 'stale cleared');
  assert.strictEqual(await callState.get(2), 'idle');

  console.log('callState.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
