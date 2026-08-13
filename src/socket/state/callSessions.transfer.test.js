const assert = require('assert');
const callSessions = require('./callSessions');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;

function openTransfer() {
  return callSessions.openWithPending({
    originCallId: 99,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
}

// ── mode join par défaut / rétrocompat ───────────────────────────────────────
callSessions._reset();
const joinS = callSessions.openWithPending({
  originCallId: 1,
  participants: [CHRIS, AWA],
  inviteeId: NADIA,
  byUserId: CHRIS,
});
assert.strictEqual(joinS.mode, 'join');
assert.strictEqual(joinS.transfer, null);
callSessions.abortPending(joinS.sessionId);

// mode invalide → join
const join2 = callSessions.openWithPending({
  originCallId: 1,
  participants: [CHRIS, AWA],
  inviteeId: NADIA,
  byUserId: CHRIS,
  mode: 'nope',
});
assert.strictEqual(join2.mode, 'join');
assert.strictEqual(join2.transfer, null);
callSessions.abortPending(join2.sessionId);

// ── mode transfer : objet obligatoire ────────────────────────────────────────
callSessions._reset();
const t = openTransfer();
assert.ok(t);
assert.strictEqual(t.mode, 'transfer');
assert.ok(t.transfer);
assert.strictEqual(t.transfer.initiatorId, CHRIS);
assert.strictEqual(t.transfer.targetId, NADIA);
assert.strictEqual(t.transfer.state, 'pending');
assert.deepStrictEqual(
  callSessions.getTransferTimerFlags(t.sessionId),
  { state: 'pending', hasLeaveTimer: false, hasReadyTimer: false },
  'pending : aucun leaveTimer',
);

// promote → joined
const promoted = callSessions.promotePending(t.sessionId);
assert.strictEqual(promoted.transfer.state, 'joined');
assert.strictEqual(promoted.addRight, 'consumed');
assert.strictEqual(
  callSessions.getTransferTimerFlags(t.sessionId).hasLeaveTimer,
  false,
  'joined sans ready : aucun leaveTimer',
);

// markTransferJoined + readyTimer
let readyFired = false;
callSessions.markTransferJoined(
  t.sessionId,
  setTimeout(() => { readyFired = true; }, 5),
);
assert.strictEqual(callSessions.get(t.sessionId).transfer.state, 'joined');

// ready de l'initiateur rejeté
let r = callSessions.registerTransferReady({
  sessionId: t.sessionId,
  reporterId: CHRIS,
  peerId: NADIA,
});
assert.strictEqual(r.ok, false);
assert.strictEqual(r.reason, 'INVALID_REPORTER');

// ready de C rejeté
r = callSessions.registerTransferReady({
  sessionId: t.sessionId,
  reporterId: NADIA,
  peerId: NADIA,
});
assert.strictEqual(r.ok, false);

// ready de B → armed une fois
let leaveArmed = false;
r = callSessions.registerTransferReady({
  sessionId: t.sessionId,
  reporterId: AWA,
  peerId: NADIA,
  leaveTimerFactory: () => setTimeout(() => { leaveArmed = true; }, 50),
});
assert.strictEqual(r.ok, true);
assert.strictEqual(r.armed, true);
assert.strictEqual(r.session.transfer.state, 'armed');
assert.strictEqual(readyFired, false, 'readyTimer annulé à l\'armement');

// double ready → no new timer
r = callSessions.registerTransferReady({
  sessionId: t.sessionId,
  reporterId: AWA,
  peerId: NADIA,
  leaveTimerFactory: () => setTimeout(() => {}, 50),
});
assert.strictEqual(r.ok, true);
assert.strictEqual(r.armed, false);

// canCompleteTransfer
assert.strictEqual(callSessions.canCompleteTransfer(callSessions.get(t.sessionId)), true);

// B part pendant armed → cancel + plus canComplete
callSessions.removeParticipant(t.sessionId, AWA);
const afterB = callSessions.get(t.sessionId);
assert.ok(afterB);
assert.strictEqual(afterB.transfer.state, 'cancelled');
assert.strictEqual(callSessions.canCompleteTransfer(afterB), false);

callSessions.destroy(t.sessionId);

// ── media timeout path : destroy annule timers ───────────────────────────────
callSessions._reset();
const t2 = openTransfer();
callSessions.promotePending(t2.sessionId);
let orphan = false;
callSessions.markTransferJoined(
  t2.sessionId,
  setTimeout(() => { orphan = true; }, 20),
);
callSessions.destroy(t2.sessionId);
setTimeout(() => {
  assert.strictEqual(orphan, false, 'readyTimer nettoyé à destroy');
  assert.strictEqual(leaveArmed, false, 'leaveTimer nettoyé au départ de B');

  // ── canCompleteTransfer exige A+B+C ───────────────────────────────────────
  callSessions._reset();
  const t3 = openTransfer();
  callSessions.promotePending(t3.sessionId);
  callSessions.registerTransferReady({
    sessionId: t3.sessionId,
    reporterId: AWA,
    peerId: NADIA,
    leaveTimerFactory: () => setTimeout(() => {}, 10000),
  });
  assert.strictEqual(callSessions.canCompleteTransfer(callSessions.get(t3.sessionId)), true);
  callSessions.removeParticipant(t3.sessionId, AWA);
  assert.strictEqual(
    callSessions.canCompleteTransfer(callSessions.get(t3.sessionId)),
    false,
    'sans B : pas d\'auto-leave',
  );

  console.log('✅ callSessions transfer helpers — tous les cas passent');
}, 40);
