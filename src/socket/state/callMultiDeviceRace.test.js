/**
 * Courses multi-device answer/reject (ownership + ExceptDevice).
 */
const assert = require('assert');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const {
  emitToUserExceptDevice,
  normalizeDeviceId,
  deviceRoom,
} = require('../../utils/userSocketRegistry');

callDeviceOwnership._reset();

function makeIo(sockets) {
  const byId = new Map(sockets.map((s) => [s.id, s]));
  const rooms = new Map();
  for (const s of sockets) {
    for (const r of s.rooms) {
      if (!rooms.has(r)) rooms.set(r, new Set());
      rooms.get(r).add(s.id);
    }
  }
  return {
    sockets: { sockets: byId, adapter: { rooms } },
  };
}

function sock(id, userId, deviceId) {
  const s = {
    id,
    alanyaID: userId,
    deviceId,
    rooms: [`user_${userId}`, deviceRoom(userId, deviceId)].filter(Boolean),
    events: [],
    emit(e, p) { this.events.push({ e, p }); },
  };
  return s;
}

// B1 gagne, B2 perd
callDeviceOwnership.ring('55', 2);
const win = callDeviceOwnership.tryClaim('55', 2, 'B1', 's1');
assert.ok(win.ok);
const lose = callDeviceOwnership.tryClaim('55', 2, 'B2', 's2');
assert.strictEqual(lose.ok, false);

const b1 = sock('s1', 2, 'B1');
const b2 = sock('s2', 2, 'B2');
const io = makeIo([b1, b2]);
emitToUserExceptDevice(io, 2, 'B1', 'call_ended', {
  callId: '55',
  reason: 'answered_elsewhere',
  claimedByAnotherDevice: true,
});
assert.strictEqual(b1.events.length, 0);
assert.strictEqual(b2.events.length, 1);
assert.strictEqual(b2.events[0].p.reason, 'answered_elsewhere');

// Reject après claim ailleurs : ownership active autre device → ignore logique
const owner = callDeviceOwnership.getEntry('55', 2);
assert.strictEqual(owner.activeDeviceId, 'B1');
const rejDid = normalizeDeviceId('B2');
assert.notStrictEqual(owner.activeDeviceId, rejDid);

console.log('callMultiDeviceRace.test.js OK');
process.exit(0);
