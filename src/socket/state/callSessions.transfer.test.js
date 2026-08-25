// Transfert d'appel — machine à états et discipline des délais.
//
// Le store est async depuis la migration Redis : ces tests exercent le repli
// mémoire (aucun REDIS_URL ici). L'unicité réelle de l'armement se vérifie
// contre un vrai Redis dans callSessions.race.test.js.
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

(async () => {
  // ── mode join par défaut / rétrocompat ─────────────────────────────────────
  callSessions._reset();
  const joinS = await callSessions.openWithPending({
    originCallId: 1,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
  });
  assert.strictEqual(joinS.mode, 'join');
  assert.strictEqual(joinS.transfer, null);
  await callSessions.abortPending(joinS.sessionId);

  // mode invalide → join
  const join2 = await callSessions.openWithPending({
    originCallId: 1,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'nope',
  });
  assert.strictEqual(join2.mode, 'join');
  assert.strictEqual(join2.transfer, null);
  await callSessions.abortPending(join2.sessionId);

  // ── mode transfer : objet obligatoire ──────────────────────────────────────
  callSessions._reset();
  const t = await openTransfer();
  assert.ok(t);
  assert.strictEqual(t.mode, 'transfer');
  assert.ok(t.transfer);
  assert.strictEqual(t.transfer.initiatorId, CHRIS);
  assert.strictEqual(t.transfer.targetId, NADIA);
  assert.strictEqual(t.transfer.state, 'pending');
  assert.deepStrictEqual(
    await callSessions.getTransferTimerFlags(t.sessionId),
    { state: 'pending', hasLeaveTimer: false, hasReadyTimer: false },
    'pending : aucun leaveTimer',
  );

  // promote → joined
  const promoted = await callSessions.promotePending(t.sessionId);
  assert.strictEqual(promoted.transfer.state, 'joined');
  assert.strictEqual(promoted.addRight, 'consumed');
  assert.strictEqual(
    (await callSessions.getTransferTimerFlags(t.sessionId)).hasLeaveTimer,
    false,
    'joined sans ready : aucun leaveTimer',
  );

  // markTransferJoined + délai média
  let readyFired = false;
  await callSessions.markTransferJoined(t.sessionId, 5, () => { readyFired = true; });
  assert.strictEqual((await callSessions.get(t.sessionId)).transfer.state, 'joined');

  // ready de l'initiateur rejeté
  let r = await callSessions.registerTransferReady({
    sessionId: t.sessionId,
    reporterId: CHRIS,
    peerId: NADIA,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'INVALID_REPORTER');

  // ready de C rejeté
  r = await callSessions.registerTransferReady({
    sessionId: t.sessionId,
    reporterId: NADIA,
    peerId: NADIA,
  });
  assert.strictEqual(r.ok, false);

  // ready de B → armed une fois
  let leaveArmed = false;
  r = await callSessions.registerTransferReady({
    sessionId: t.sessionId,
    reporterId: AWA,
    peerId: NADIA,
    leaveTimerMs: 50,
    onLeave: () => { leaveArmed = true; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.armed, true);
  assert.strictEqual(r.session.transfer.state, 'armed');
  assert.strictEqual(readyFired, false, 'délai média annulé à l\'armement');

  // double ready → aucun nouveau délai
  r = await callSessions.registerTransferReady({
    sessionId: t.sessionId,
    reporterId: AWA,
    peerId: NADIA,
    leaveTimerMs: 50,
    onLeave: () => {},
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.armed, false);

  // canCompleteTransfer
  assert.strictEqual(callSessions.canCompleteTransfer(await callSessions.get(t.sessionId)), true);

  // B part pendant armed → cancel + plus canComplete
  await callSessions.removeParticipant(t.sessionId, AWA);
  const afterB = await callSessions.get(t.sessionId);
  assert.ok(afterB);
  assert.strictEqual(afterB.transfer.state, 'cancelled');
  assert.strictEqual(callSessions.canCompleteTransfer(afterB), false);

  await callSessions.destroy(t.sessionId);

  // ── destroy annule les délais en cours ─────────────────────────────────────
  callSessions._reset();
  const t2 = await openTransfer();
  await callSessions.promotePending(t2.sessionId);
  let orphan = false;
  await callSessions.markTransferJoined(t2.sessionId, 20, () => { orphan = true; });
  await callSessions.destroy(t2.sessionId);

  await new Promise((res) => setTimeout(res, 40));
  assert.strictEqual(orphan, false, 'délai média nettoyé à destroy');
  assert.strictEqual(leaveArmed, false, 'délai de sortie nettoyé au départ de B');

  // ── canCompleteTransfer exige A+B+C ────────────────────────────────────────
  callSessions._reset();
  const t3 = await openTransfer();
  await callSessions.promotePending(t3.sessionId);
  await callSessions.registerTransferReady({
    sessionId: t3.sessionId,
    reporterId: AWA,
    peerId: NADIA,
    leaveTimerMs: 10000,
    onLeave: () => {},
  });
  assert.strictEqual(callSessions.canCompleteTransfer(await callSessions.get(t3.sessionId)), true);
  await callSessions.removeParticipant(t3.sessionId, AWA);
  assert.strictEqual(
    callSessions.canCompleteTransfer(await callSessions.get(t3.sessionId)),
    false,
    'sans B : pas d\'auto-leave',
  );
  await callSessions.destroy(t3.sessionId);

  console.log('✅ callSessions transfer helpers — tous les cas passent');
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
