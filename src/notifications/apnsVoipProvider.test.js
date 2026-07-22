const assert = require('assert');
const { buildVoipCallPayload, isConfigured } = require('./apnsVoipProvider');

const payload = buildVoipCallPayload({
  type: 'call',
  callId: '42',
  callerId: '10',
  callerName: 'Alice',
  photo: 'https://example.com/a.jpg',
  isVideo: true,
});

assert.strictEqual(payload.id, '42');
assert.strictEqual(payload.callId, '42');
assert.strictEqual(payload.callerId, '10');
assert.strictEqual(payload.callerName, 'Alice');
assert.strictEqual(payload.isVideo, 'true');
assert.strictEqual(payload.type, 'call');

const groupPayload = buildVoipCallPayload({
  type: 'group_call',
  roomId: 'room-1',
  callerName: 'Bob',
});
assert.strictEqual(groupPayload.id, 'room-1');
assert.strictEqual(groupPayload.roomId, 'room-1');

assert.strictEqual(typeof isConfigured(), 'boolean');

console.log('apnsVoipProvider.test.js OK');
