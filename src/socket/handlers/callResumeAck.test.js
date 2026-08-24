// Reprise d'appel : call_resume exige un ack client ; reject/timeout soldent
// l'in_call fantôme (régression CALLER_BUSY après auth:login idle).
// Owner-only : pas de broadcast ; non-owner ignore reject ; owner absent → timer dédié.
//
// callState/callDeviceOwnership/pendingCalls sont async depuis la phase 2
// Redis (repli mémoire ici, aucun Redis configuré dans ce test).
// offerCallResume est également async depuis cette phase.
const assert = require('assert');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const pendingCalls = require('../state/pendingCalls');
const { deviceRoom } = require('../../utils/deviceId');
const {
  offerCallResume,
  callResumeHandshake,
  endActiveCallForUser,
} = require('./calls');

async function reset() {
  for (const id of [10, 77]) {
    await callState.clear(id);
    await pendingCalls.clear(id);
  }
  await callDeviceOwnership.release('1329');
  await callDeviceOwnership.release('2000');
}

function fakeSocket(userId, deviceId = `dev_${userId}`) {
  const emitted = [];
  const handlers = {};
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    async trigger(event, data) {
      await handlers[event](data);
    },
    get emitted() {
      return emitted;
    },
  };
}

function fakeIo() {
  const roomEmits = [];
  return {
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return {
        emit(event, payload) {
          roomEmits.push({ room, event, payload });
        },
      };
    },
    get roomEmits() {
      return roomEmits;
    },
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setOwner(callId, userId, deviceId) {
  await callDeviceOwnership.setActive(callId, userId, {
    activeDeviceId: deviceId,
    activeSocketId: `s_${userId}`,
  });
}

async function main() {
  // 1) offerCallResume émet call_resume vers le device owner et conserve disconnect grace.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77, isVideo: false });
  await callState.setInCall(77, { callId: '1329', peerId: 10, isVideo: false });
  await setOwner('1329', 10, 'dev_10');
  const graceFired = { n: 0 };
  await callState.scheduleDisconnectGrace(10, () => {
    graceFired.n += 1;
  });
  const sock10 = fakeSocket(10, 'dev_10');
  const io = fakeIo();
  const userSockets = new Map();
  assert.strictEqual(await offerCallResume(io, sock10, userSockets, 10), true);
  const resumeEmit = io.roomEmits.find((e) => e.event === 'call_resume');
  assert.ok(resumeEmit, 'call_resume émis via emitToDevice');
  assert.strictEqual(resumeEmit.room, deviceRoom(10, 'dev_10'));
  assert.strictEqual(resumeEmit.payload?.callId, '1329');
  assert.ok((await callState.getEntry(10))?.disconnectTimer, 'grâce disconnect conservée');
  assert.ok((await callState.getEntry(10))?.resumeAckTimer, 'timeout ack armé');
  assert.strictEqual(graceFired.n, 0, 'grâce pas encore expirée');

  // 1b) Socket non-owner : pas d'émission, pas de reject path.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77 });
  await callState.setInCall(77, { callId: '1329', peerId: 10 });
  await setOwner('1329', 10, 'dev_10');
  const sockSecondary = fakeSocket(10, 'dev_secondary');
  const io2 = fakeIo();
  assert.strictEqual(await offerCallResume(io2, sockSecondary, userSockets, 10), false);
  assert.strictEqual(
    io2.roomEmits.filter((e) => e.event === 'call_resume').length,
    0,
    'pas de call_resume vers non-owner',
  );
  assert.strictEqual((await callState.getEntry(10))?.resumeAckTimer, null, 'pas de timeout ack sur secondary');

  // 1c) Owner absent : pas d'emitToUser, timer dédié puis endActiveCall.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77 });
  await callState.setInCall(77, { callId: '1329', peerId: 10 });
  // pas de setOwner
  const io3 = fakeIo();
  const sockNoOwner = fakeSocket(10, 'dev_10');
  assert.strictEqual(await offerCallResume(io3, sockNoOwner, userSockets, 10), false);
  assert.strictEqual(io3.roomEmits.length, 0, 'aucun resume sans owner');
  assert.ok((await callState.getEntry(10))?.resumeOwnerMissingTimer, 'timer owner missing armé');
  await callState.cancelResumeOwnerMissing(10);
  await callState.scheduleResumeOwnerMissing(10, async () => {
    await endActiveCallForUser(io3, userSockets, 10, 'resume_owner_missing');
    await callDeviceOwnership.release('1329');
  }, 20);
  await wait(60);
  assert.strictEqual(await callState.get(10), 'idle', 'owner missing nettoie caller');
  assert.strictEqual(await callState.get(77), 'idle', 'owner missing nettoie peer');

  // 2) call_resume_ack confirme et annule grâce + timeout.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77, isVideo: false });
  await callState.setInCall(77, { callId: '1329', peerId: 10, isVideo: false });
  await setOwner('1329', 10, 'dev_10');
  await callState.scheduleDisconnectGrace(10, () => {});
  const sockAck = fakeSocket(10, 'dev_10');
  await offerCallResume(fakeIo(), sockAck, userSockets, 10);
  callResumeHandshake(fakeIo(), sockAck, userSockets);
  await sockAck.trigger('call_resume_ack', { callId: '1329' });
  assert.strictEqual(await callState.get(10), 'in_call', 'appel conservé après ack');
  assert.strictEqual((await callState.getEntry(10))?.disconnectTimer, null, 'grâce annulée');
  assert.strictEqual((await callState.getEntry(10))?.resumeAckTimer, null, 'timeout ack annulé');

  // 2b) Non-owner reject ignoré — appel reste actif.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77 });
  await callState.setInCall(77, { callId: '1329', peerId: 10 });
  await setOwner('1329', 10, 'dev_10');
  const sockRejectSecondary = fakeSocket(10, 'dev_other');
  callResumeHandshake(fakeIo(), sockRejectSecondary, userSockets);
  await sockRejectSecondary.trigger('call_resume_reject', {
    callId: '1329',
    reason: 'no_local_call_state',
  });
  assert.strictEqual(await callState.get(10), 'in_call', 'reject non-owner n\'arrête pas l\'appel');
  assert.strictEqual(await callState.get(77), 'in_call');

  // 3) call_resume_reject owner soldé l'appel fantôme des deux côtés.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77 });
  await callState.setInCall(77, { callId: '1329', peerId: 10 });
  await setOwner('1329', 10, 'dev_10');
  const sockReject = fakeSocket(10, 'dev_10');
  callResumeHandshake(fakeIo(), sockReject, userSockets);
  await sockReject.trigger('call_resume_reject', {
    callId: '1329',
    reason: 'no_local_call_state',
  });
  assert.strictEqual(await callState.get(10), 'idle', 'caller nettoyé');
  assert.strictEqual(await callState.get(77), 'idle', 'peer nettoyé');
  assert.strictEqual(
    await callDeviceOwnership.getEntry('1329', 10),
    null,
    'ownership released',
  );

  // 4) Timeout resume ack sans réponse → endActiveCall.
  await reset();
  await callState.setInCall(10, { callId: '1329', peerId: 77 });
  await callState.setInCall(77, { callId: '1329', peerId: 10 });
  await setOwner('1329', 10, 'dev_10');
  const sockTimeout = fakeSocket(10, 'dev_10');
  await offerCallResume(fakeIo(), sockTimeout, userSockets, 10);
  await callState.cancelResumeAck(10);
  await callState.scheduleResumeAck(10, async () => {
    await endActiveCallForUser(fakeIo(), userSockets, 10, 'resume_ack_timeout');
    await callDeviceOwnership.release('1329');
  }, 20);
  await wait(60);
  assert.strictEqual(await callState.get(10), 'idle', 'timeout nettoie caller');
  assert.strictEqual(await callState.get(77), 'idle', 'timeout nettoie peer');

  // 5) Contre-test : vrai appel + ack → busy pour un nouvel appel.
  await reset();
  await callState.setInCall(10, { callId: '2000', peerId: 77 });
  await callState.setInCall(77, { callId: '2000', peerId: 10 });
  await setOwner('2000', 10, 'dev_10');
  const sockLive = fakeSocket(10, 'dev_10');
  await offerCallResume(fakeIo(), sockLive, userSockets, 10);
  callResumeHandshake(fakeIo(), sockLive, userSockets);
  await sockLive.trigger('call_resume_ack', { callId: '2000' });
  assert.strictEqual(
    await callState.isBusyForNewCall(10, 99, pendingCalls),
    true,
    'vrai in_call → busy pour autre cible',
  );

  await reset();
  console.log('callResumeAck.test.js OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
