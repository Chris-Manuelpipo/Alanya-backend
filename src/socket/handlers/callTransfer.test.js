// Tests protocole transfert (fake timers) — sans DB réelle pour le happy path
// des timers. Les appels closeSessionHistoryFor peuvent échouer silencieusement
// sans base (comme callSessionLeave.test.js).
const assert = require('assert');
const { leaveCallSession, failInvite } = require('./calls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const pendingCalls = require('../state/pendingCalls');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;

function fakeIo() {
  const sent = [];
  return {
    sent,
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
        },
      };
    },
    eventsFor(userId) {
      return sent.filter((e) => e.room === `user_${userId}`).map((e) => e.event);
    },
    payloadFor(userId, event) {
      return sent.find((e) => e.room === `user_${userId}` && e.event === event)?.payload;
    },
  };
}

function reset() {
  [CHRIS, AWA, NADIA].forEach((id) => {
    callState.clear(id);
    pendingCalls.clear(id);
  });
  callSessions._reset();
}

function twoWay() {
  callState.setInCall(CHRIS, { peerId: AWA, callId: 50 });
  callState.setInCall(AWA, { peerId: CHRIS, callId: 50 });
}

(async () => {
  // ── Transfert réussi : ready B → armed → leave A ───────────────────────────
  reset();
  twoWay();
  const s = callSessions.openWithPending({
    originCallId: 50,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
  assert.strictEqual(s.mode, 'transfer');
  callSessions.promotePending(s.sessionId);
  callState.setInCall(NADIA, { peerId: CHRIS, callId: s.sessionId });

  const io = fakeIo();
  let autoLeaveScheduled = null;
  const ready = callSessions.registerTransferReady({
    sessionId: s.sessionId,
    reporterId: AWA,
    peerId: NADIA,
    leaveTimerFactory: () => {
      autoLeaveScheduled = setTimeout(() => {}, 10_000);
      return autoLeaveScheduled;
    },
  });
  assert.strictEqual(ready.armed, true);
  assert.strictEqual(callSessions.canCompleteTransfer(callSessions.get(s.sessionId)), true);

  // Simuler expiration : leave A
  clearTimeout(autoLeaveScheduled);
  await leaveCallSession(io, null, CHRIS, 'transfer');
  assert.deepStrictEqual(
    callSessions.participantIds(callSessions.getByUser(AWA)).sort((a, b) => a - b),
    [AWA, NADIA],
  );
  assert.ok(io.eventsFor(AWA).includes('call_conf_left'));
  assert.ok(io.eventsFor(NADIA).includes('call_conf_left'));

  // ── Ready de A ignoré ──────────────────────────────────────────────────────
  reset();
  twoWay();
  const s2 = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
  callSessions.promotePending(s2.sessionId);
  const bad = callSessions.registerTransferReady({
    sessionId: s2.sessionId,
    reporterId: CHRIS,
    peerId: NADIA,
  });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(callSessions.get(s2.sessionId).transfer.state, 'joined');

  // ── media_not_ready : retire C, A/B restent ────────────────────────────────
  reset();
  twoWay();
  const s3 = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
  callSessions.promotePending(s3.sessionId);
  callState.setInCall(NADIA, { peerId: CHRIS });
  callSessions.cancelTransfer(s3.sessionId, 'media_not_ready');
  const io3 = fakeIo();
  await leaveCallSession(io3, null, NADIA, 'media_not_ready');
  assert.strictEqual(callState.get(CHRIS), 'in_call');
  assert.strictEqual(callState.get(AWA), 'in_call');
  assert.strictEqual(callState.get(NADIA), 'idle');
  assert.ok(
    io3.payloadFor(CHRIS, 'call_conf_left')?.reason === 'media_not_ready' ||
      io3.eventsFor(CHRIS).includes('call_conf_left'),
  );

  // ── B quitte pendant pending → pas de A+pending C ──────────────────────────
  reset();
  twoWay();
  const s4 = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'join',
  });
  callState.setRinging(NADIA, { callId: s4.sessionId, peerId: CHRIS });
  const io4 = fakeIo();
  await leaveCallSession(io4, null, AWA, 'hangup');
  assert.strictEqual(callSessions.get(s4.sessionId), null, 'session détruite');
  assert.strictEqual(callSessions.getByUser(NADIA), null);
  assert.ok(
    io4.eventsFor(NADIA).includes('call_ended') ||
      io4.eventsFor(CHRIS).includes('call_conf_failed') ||
      io4.eventsFor(CHRIS).includes('call_ended'),
  );

  // ── mode absent = join, pas de transfer ────────────────────────────────────
  reset();
  const s5 = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
  });
  assert.strictEqual(s5.mode, 'join');
  assert.strictEqual(s5.transfer, null);
  callSessions.promotePending(s5.sessionId);
  const noReady = callSessions.registerTransferReady({
    sessionId: s5.sessionId,
    reporterId: AWA,
    peerId: NADIA,
  });
  assert.strictEqual(noReady.ok, false);

  // ── C quitte pendant armed → cancel, A/B restent ───────────────────────────
  reset();
  twoWay();
  const s6 = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
  callSessions.promotePending(s6.sessionId);
  callState.setInCall(NADIA, { peerId: CHRIS });
  callSessions.registerTransferReady({
    sessionId: s6.sessionId,
    reporterId: AWA,
    peerId: NADIA,
    leaveTimerFactory: () => setTimeout(() => {}, 10_000),
  });
  const io6 = fakeIo();
  await leaveCallSession(io6, null, NADIA, 'hangup');
  assert.strictEqual(callState.get(CHRIS), 'in_call');
  assert.strictEqual(callState.get(AWA), 'in_call');
  const rem = callSessions.getByUser(CHRIS);
  assert.ok(rem);
  assert.strictEqual(rem.transfer.state, 'cancelled');

  // ── Handler Socket confReady → armed → auto-leave (fake timers) ────────────
  reset();
  twoWay();
  const s7 = callSessions.openWithPending({
    originCallId: 77,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
  callSessions.promotePending(s7.sessionId);
  callState.setInCall(NADIA, { peerId: CHRIS, callId: s7.sessionId });

  // Ownership : B (AWA) est le device média actif pour call_conf_ready.
  const callDeviceOwnership = require('../state/callDeviceOwnership');
  callDeviceOwnership._reset();
  callDeviceOwnership.setCalling(s7.sessionId, CHRIS, {
    activeDeviceId: 'dev-A',
    activeSocketId: 'sa',
  });
  const eA = callDeviceOwnership.getEntry(s7.sessionId, CHRIS);
  if (eA) eA.state = 'active';
  callDeviceOwnership.tryClaim(s7.sessionId, AWA, 'dev-B', 'sb');
  callDeviceOwnership.tryClaim(s7.sessionId, NADIA, 'dev-C', 'sc');

  const io7 = fakeIo();
  const scheduled = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  // N'intercepter que les timers transfert ; laisser passer le reste (pool MySQL, etc.).
  global.setTimeout = (fn, ms, ...args) => {
    if (
      ms === callSessions.TRANSFER_AUTO_LEAVE_MS ||
      ms === callSessions.TRANSFER_READY_TIMEOUT_MS
    ) {
      const handle = { fn, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'cleared' in handle) {
      handle.cleared = true;
      return;
    }
    return realClearTimeout(handle);
  };

  try {
    const { confReady } = require('./calls');
    const handlers = {};
    const fakeSocket = {
      authenticated: true,
      alanyaID: AWA,
      deviceId: 'dev-B',
      on(event, fn) {
        handlers[event] = fn;
      },
    };
    confReady(io7, fakeSocket, null);
    assert.ok(typeof handlers.call_conf_ready === 'function');

    handlers.call_conf_ready({
      sessionId: s7.sessionId,
      peerId: String(NADIA),
    });

    assert.ok(
      io7.sent.some((e) => e.event === 'call_transfer_armed'),
      'initiateur reçoit call_transfer_armed',
    );
    const armed = callSessions.get(s7.sessionId);
    assert.strictEqual(armed.transfer.state, 'armed');

    const leaveHandles = scheduled.filter(
      (h) => h.ms === callSessions.TRANSFER_AUTO_LEAVE_MS && !h.cleared,
    );
    assert.strictEqual(leaveHandles.length, 1, 'un seul leaveTimer');

    // Le callback setTimeout lance onTransferAutoLeave en fire-and-forget :
    // callState.clear arrive avant les emits (après await closeSessionHistoryFor).
    leaveHandles[0].fn();
    for (let i = 0; i < 120; i++) {
      if (io7.eventsFor(AWA).includes('call_conf_left')) break;
      await new Promise((r) => realSetTimeout(r, 25));
    }

    assert.strictEqual(callState.get(CHRIS), 'idle', 'initiateur retiré');
    assert.strictEqual(callState.get(AWA), 'in_call');
    assert.strictEqual(callState.get(NADIA), 'in_call');
    assert.ok(io7.eventsFor(AWA).includes('call_conf_left'));
    assert.ok(io7.eventsFor(NADIA).includes('call_conf_left'));
    assert.ok(
      io7.eventsFor(CHRIS).includes('call_transfer_done'),
      'call_transfer_done à l\'initiateur',
    );
    assert.ok(
      io7.eventsFor(CHRIS).includes('call_ended'),
      'call_ended à l\'initiateur (CallKit)',
    );
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }

  console.log('✅ callTransfer.test.js — tous les cas passent');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
