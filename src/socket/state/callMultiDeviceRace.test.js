/**
 * Courses multi-device answer/reject (ownership + ExceptDevice).
 *
 * emitToUserExceptDevice est async depuis l'intégration Redis (phase 1) —
 * fetchSockets() cross-instance plutôt qu'une lecture locale de l'adapter.
 * callDeviceOwnership est async depuis la phase 2 (repli mémoire ici, aucun
 * Redis configuré dans ce test). Voir src/testUtils/fakeIo.js.
 */
const assert = require('assert');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const {
  emitToUserExceptDevice,
  normalizeDeviceId,
} = require('../../utils/userSocketRegistry');
const { makeFakeIo, fakeSocket } = require('../../testUtils/fakeIo');

callDeviceOwnership._reset();

(async () => {
  // B1 gagne, B2 perd
  await callDeviceOwnership.ring('55', 2);
  const win = await callDeviceOwnership.tryClaim('55', 2, 'B1', 's1');
  assert.ok(win.ok);
  const lose = await callDeviceOwnership.tryClaim('55', 2, 'B2', 's2');
  assert.strictEqual(lose.ok, false);

  const b1 = fakeSocket('s1', { userId: 2, deviceId: 'B1' });
  const b2 = fakeSocket('s2', { userId: 2, deviceId: 'B2' });
  const io = makeFakeIo([b1, b2]);
  await emitToUserExceptDevice(io, 2, 'B1', 'call_ended', {
    callId: '55',
    reason: 'answered_elsewhere',
    claimedByAnotherDevice: true,
  });
  assert.strictEqual(b1.events.length, 0);
  assert.strictEqual(b2.events.length, 1);
  assert.strictEqual(b2.events[0].event, 'call_ended');
  assert.strictEqual(b2.events[0].payload.reason, 'answered_elsewhere');

  // Reject après claim ailleurs : ownership active autre device → ignore logique
  const owner = await callDeviceOwnership.getEntry('55', 2);
  assert.strictEqual(owner.activeDeviceId, 'B1');
  const rejDid = normalizeDeviceId('B2');
  assert.notStrictEqual(owner.activeDeviceId, rejDid);

  console.log('callMultiDeviceRace.test.js OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
