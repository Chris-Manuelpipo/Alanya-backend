/**
 * Tests deviceId canonique + rooms account-scoped + ExceptDevice.
 *
 * emitToUserExceptDevice est async depuis l'intégration Redis (phase 1) —
 * fetchSockets() cross-instance plutôt qu'une lecture locale de l'adapter.
 * emitToDevice, lui, reste synchrone (déjà propagé par l'adapter via
 * io.to(room).emit()). Voir src/testUtils/fakeIo.js.
 */
const assert = require('assert');
const {
  normalizeDeviceId,
  deviceRoom,
} = require('./deviceId');
const {
  emitToDevice,
  emitToUserExceptDevice,
  createUserSocketRegistry,
} = require('./userSocketRegistry');
const callDeviceOwnership = require('../socket/state/callDeviceOwnership');
const meetingDevicePresence = require('../socket/state/meetingDevicePresence');
const { makeFakeIo, fakeSocket } = require('../testUtils/fakeIo');

(async () => {
  // ── normalizeDeviceId ──────────────────────────────────────────────────────
  assert.strictEqual(normalizeDeviceId(null), null);
  assert.strictEqual(normalizeDeviceId(''), null);
  assert.strictEqual(normalizeDeviceId('  '), null);
  assert.strictEqual(normalizeDeviceId('INDEFINI'), null);
  assert.strictEqual(normalizeDeviceId('  abc  '), 'abc');
  assert.strictEqual(normalizeDeviceId('x'.repeat(200)).length, 128);

  // ── deviceRoom account-scoped ──────────────────────────────────────────────
  assert.strictEqual(deviceRoom(42, 'phone-a'), 'user_42_device_phone-a');
  assert.strictEqual(deviceRoom(7, 'phone-a'), 'user_7_device_phone-a');
  assert.notStrictEqual(deviceRoom(42, 'phone-a'), deviceRoom(7, 'phone-a'));
  assert.strictEqual(deviceRoom(42, 'INDEFINI'), null);
  assert.strictEqual(deviceRoom(null, 'x'), null);

  // ── emitToUserExceptDevice ─────────────────────────────────────────────────
  const mk = (id, userId, deviceId) =>
    fakeSocket(id, { userId, deviceId, extraRooms: [deviceRoom(userId, deviceId)].filter(Boolean) });

  const b1 = mk('b1', 2, 'dev-B1');
  const b2 = mk('b2', 2, 'dev-B2');
  const b1b = mk('b1b', 2, 'dev-B1'); // 2e socket même device
  const io = makeFakeIo([b1, b2, b1b]);

  await emitToUserExceptDevice(io, 2, 'dev-B1', 'call_ended', {
    callId: '99',
    reason: 'answered_elsewhere',
  });
  assert.strictEqual(b1.events.length, 0, 'gagnant B1 socket1 exclu');
  assert.strictEqual(b1b.events.length, 0, 'gagnant B1 socket2 exclu');
  assert.strictEqual(b2.events.length, 1, 'frère B2 reçoit');
  assert.strictEqual(b2.events[0].payload.reason, 'answered_elsewhere');

  // emitToDevice ciblé
  const a1 = mk('a1', 1, 'dev-A');
  const a2 = mk('a2', 1, 'dev-A2');
  const ioA = makeFakeIo([a1, a2]);
  emitToDevice(ioA, 1, 'dev-A', 'call_answered', { answer: true });
  assert.strictEqual(a1.events.length, 1);
  assert.strictEqual(a2.events.length, 0);

  // ── ownership claim atomique ───────────────────────────────────────────────
  callDeviceOwnership._reset();
  await callDeviceOwnership.setCalling('100', 1, {
    activeDeviceId: 'dev-A',
    activeSocketId: 'sa',
  });
  await callDeviceOwnership.ring('100', 2);
  const c1 = await callDeviceOwnership.tryClaim('100', 2, 'dev-B1', 'sb1');
  assert.strictEqual(c1.ok, true);
  const c2 = await callDeviceOwnership.tryClaim('100', 2, 'dev-B2', 'sb2');
  assert.strictEqual(c2.ok, false);
  assert.strictEqual(c2.reason, 'CALL_ANSWERED_ELSEWHERE');
  assert.strictEqual(await callDeviceOwnership.getActiveDeviceId('100', 1), 'dev-A');
  assert.strictEqual(await callDeviceOwnership.isOwnerDevice('100', 2, 'dev-B1'), true);
  assert.strictEqual(await callDeviceOwnership.isOwnerDevice('100', 2, 'dev-B2'), false);

  // tryClaim n'invente pas de session
  const ghost = await callDeviceOwnership.tryClaim('missing', 9, 'dev-X', 'sx');
  assert.strictEqual(ghost.ok, false);
  assert.strictEqual(ghost.reason, 'NO_SESSION');

  // ── meeting presence ───────────────────────────────────────────────────────
  meetingDevicePresence._reset();
  const j1 = await meetingDevicePresence.tryJoin(55, 9, 'm1', 's1');
  assert.strictEqual(j1.ok, true);
  const j2 = await meetingDevicePresence.tryJoin(55, 9, 'm2', 's2');
  assert.strictEqual(j2.ok, false);
  assert.strictEqual(j2.code, 'ACCOUNT_ALREADY_IN_MEETING');
  const j1r = await meetingDevicePresence.tryJoin(55, 9, 'm1', 's1b');
  assert.strictEqual(j1r.ok, true);
  assert.strictEqual(j1r.resumed, true);

  // Correspondance socket.deviceId == push deviceId (après normalize)
  const socketDid = normalizeDeviceId('  push-dev-1  ');
  const pushDid = normalizeDeviceId('push-dev-1');
  assert.strictEqual(socketDid, pushDid);

  console.log('deviceIdOwnershipFoundation.test.js OK');
  createUserSocketRegistry(); // smoke
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
