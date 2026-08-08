// Reprise d'appel : call_resume exige un ack client ; reject/timeout soldent
// l'in_call fantôme (régression CALLER_BUSY après auth:login idle).
const assert = require('assert');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const pendingCalls = require('../state/pendingCalls');
const {
  offerCallResume,
  callResumeHandshake,
  endActiveCallForUser,
} = require('./calls');

function reset() {
  [10, 77].forEach((id) => {
    callState.clear(id);
    pendingCalls.clear(id);
  });
  callDeviceOwnership.release('1329');
  callDeviceOwnership.release('2000');
}

function fakeSocket(userId) {
  const emitted = [];
  const handlers = {};
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: `dev_${userId}`,
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
  return {
    sockets: { adapter: { rooms: new Map() } },
    to() {
      return { emit() {} };
    },
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1) offerCallResume émet call_resume et conserve disconnect grace.
  reset();
  callState.setInCall(10, { callId: '1329', peerId: 77, isVideo: false });
  callState.setInCall(77, { callId: '1329', peerId: 10, isVideo: false });
  const graceFired = { n: 0 };
  callState.scheduleDisconnectGrace(10, () => {
    graceFired.n += 1;
  });
  const sock10 = fakeSocket(10);
  const io = fakeIo();
  const userSockets = new Map();
  assert.strictEqual(offerCallResume(io, sock10, userSockets, 10), true);
  assert.strictEqual(sock10.emitted[0]?.event, 'call_resume');
  assert.strictEqual(sock10.emitted[0]?.payload?.callId, '1329');
  assert.ok(callState.getEntry(10)?.disconnectTimer, 'grâce disconnect conservée');
  assert.ok(callState.getEntry(10)?.resumeAckTimer, 'timeout ack armé');
  assert.strictEqual(graceFired.n, 0, 'grâce pas encore expirée');

  // 2) call_resume_ack confirme et annule grâce + timeout.
  callResumeHandshake(io, sock10, userSockets);
  await sock10.trigger('call_resume_ack', { callId: '1329' });
  assert.strictEqual(callState.get(10), 'in_call', 'appel conservé après ack');
  assert.strictEqual(callState.getEntry(10)?.disconnectTimer, null, 'grâce annulée');
  assert.strictEqual(callState.getEntry(10)?.resumeAckTimer, null, 'timeout ack annulé');

  // 3) call_resume_reject soldé l'appel fantôme des deux côtés.
  reset();
  callState.setInCall(10, { callId: '1329', peerId: 77 });
  callState.setInCall(77, { callId: '1329', peerId: 10 });
  callDeviceOwnership.setCalling('1329', 10, {
    activeDeviceId: 'dev_10',
    activeSocketId: 's1',
  });
  const sockReject = fakeSocket(10);
  callResumeHandshake(io, sockReject, userSockets);
  await sockReject.trigger('call_resume_reject', {
    callId: '1329',
    reason: 'no_local_call_state',
  });
  assert.strictEqual(callState.get(10), 'idle', 'caller nettoyé');
  assert.strictEqual(callState.get(77), 'idle', 'peer nettoyé');
  assert.strictEqual(
    callDeviceOwnership.getEntry('1329', 10),
    null,
    'ownership released',
  );

  // 4) Timeout resume ack sans réponse → endActiveCall.
  reset();
  callState.setInCall(10, { callId: '1329', peerId: 77 });
  callState.setInCall(77, { callId: '1329', peerId: 10 });
  const sockTimeout = fakeSocket(10);
  offerCallResume(io, sockTimeout, userSockets, 10);
  callState.cancelResumeAck(10);
  callState.scheduleResumeAck(10, async () => {
    await endActiveCallForUser(io, userSockets, 10, 'resume_ack_timeout');
    callDeviceOwnership.release('1329');
  }, 20);
  await wait(60);
  assert.strictEqual(callState.get(10), 'idle', 'timeout nettoie caller');
  assert.strictEqual(callState.get(77), 'idle', 'timeout nettoie peer');

  // 5) Contre-test : vrai appel + ack → busy pour un nouvel appel.
  reset();
  callState.setInCall(10, { callId: '2000', peerId: 77 });
  callState.setInCall(77, { callId: '2000', peerId: 10 });
  const sockLive = fakeSocket(10);
  offerCallResume(io, sockLive, userSockets, 10);
  callResumeHandshake(io, sockLive, userSockets);
  await sockLive.trigger('call_resume_ack', { callId: '2000' });
  assert.strictEqual(
    callState.isBusyForNewCall(10, 99, pendingCalls),
    true,
    'vrai in_call → busy pour autre cible',
  );

  reset();
  console.log('callResumeAck.test.js OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
