const assert = require('assert');
const callState = require('./callState');

// Reset module state between tests (same process).
const reset = () => {
  callState.clear(1);
  callState.clear(2);
  callState.clear(3);
};

reset();
callState.setRinging(2, { callId: '100', peerId: 1 });
assert.strictEqual(callState.isBusyForNewCall(2, 1), false, 'glare callee');
assert.strictEqual(callState.isBusyForNewCall(1, 2), false, 'glare caller');

reset();
callState.setRinging(2, { callId: '100', peerId: 1 });
assert.strictEqual(callState.isBusyForNewCall(2, 3), true, 'busy with other');

reset();
callState.setRinging(1, { callId: '101', peerId: 2 });
callState.setRinging(2, { callId: '101', peerId: 1 });
const pair = callState.findExistingRingingPair(1, 2);
assert.ok(pair);
assert.strictEqual(pair.callId, '101');

reset();
callState.setRinging(2, {
  callId: '102',
  peerId: 1,
  timer: null,
});
const entry = callState.getEntry(2);
entry.ringingSince = Date.now() - callState.STALE_RINGING_MS - 1000;
assert.strictEqual(callState.isBusyForNewCall(2, 3), false, 'stale cleared');
assert.strictEqual(callState.get(2), 'idle');

console.log('callState.test.js OK');
