// Sessions d'appel à trois — droit d'ajout, promotion, départs.
//
// Le store est async depuis la migration Redis : ces tests exercent le repli
// mémoire (aucun REDIS_URL ici). L'atomicité réelle de `openWithPending` se
// vérifie contre un vrai Redis dans callSessions.race.test.js — en mémoire,
// JS étant mono-thread, elle est acquise d'office et ne prouverait rien.
const assert = require('assert');
const callSessions = require('./callSessions');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;
const SAMUEL = 4;

const openDefault = (overrides = {}) =>
  callSessions.openWithPending({
    originCallId: 77,
    isVideo: false,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    ...overrides,
  });

(async () => {
  // ── Droit d'ajout disponible tant qu'aucune session n'existe ────────────────
  callSessions._reset();
  assert.strictEqual(await callSessions.hasAddRight(CHRIS), true, 'droit dispo au départ');
  assert.strictEqual(await callSessions.getByUser(CHRIS), null, 'pas de session au départ');

  // ── Ouverture : verrouille le droit pour les trois ──────────────────────────
  const session = await openDefault();
  assert.ok(session, 'session créée');
  assert.strictEqual(session.addRight, 'locked');
  assert.strictEqual(session.participants.size, 2, 'invité pas encore participant');
  assert.strictEqual(session.pending.userId, NADIA);
  assert.strictEqual(session.pending.byUserId, CHRIS);
  assert.strictEqual(session.originCallId, '77');
  for (const uid of [CHRIS, AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), false, `droit verrouillé pour ${uid}`);
    assert.strictEqual((await callSessions.getByUser(uid))?.sessionId, session.sessionId);
  }
  assert.strictEqual(callSessions.isPending(session, NADIA), true);
  assert.strictEqual(callSessions.isPending(session, AWA), false);
  assert.deepStrictEqual(callSessions.peersOf(session, CHRIS), [AWA]);

  // ── Course : le second appui repart bredouille ──────────────────────────────
  const loser = await callSessions.openWithPending({
    originCallId: 77,
    participants: [CHRIS, AWA],
    inviteeId: SAMUEL,
    byUserId: AWA,
  });
  assert.strictEqual(loser, null, 'un seul ajout par appel');

  // ── Échec de l'invitation : le droit revient AUX DEUX ───────────────────────
  const aborted = await callSessions.abortPending(session.sessionId);
  assert.strictEqual(aborted, NADIA, 'invité retiré');
  assert.strictEqual(await callSessions.get(session.sessionId), null, 'session détruite');
  for (const uid of [CHRIS, AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
  }

  // ── Une nouvelle tentative est alors possible, y compris par l'autre ────────
  const retry = await callSessions.openWithPending({
    originCallId: 77,
    participants: [CHRIS, AWA],
    inviteeId: SAMUEL,
    byUserId: AWA,
  });
  assert.ok(retry, 'nouvelle tentative autorisée après échec');
  await callSessions.abortPending(retry.sessionId);

  // ── Acceptation : droit consommé, trois participants ────────────────────────
  callSessions._reset();
  const live = await openDefault();
  const promoted = await callSessions.promotePending(live.sessionId);
  assert.ok(promoted, 'invité promu');
  assert.strictEqual(promoted.addRight, 'consumed');
  assert.strictEqual(promoted.pending, null);
  assert.strictEqual(promoted.participants.size, 3);
  assert.deepStrictEqual(
    callSessions.participantIds(promoted).sort((a, b) => a - b),
    [CHRIS, AWA, NADIA],
  );
  assert.strictEqual(callSessions.isPending(promoted, NADIA), false);

  // Plus personne ne peut ajouter, l'invité pas davantage que les autres.
  for (const uid of [CHRIS, AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), false, `droit consommé pour ${uid}`);
  }
  assert.strictEqual(
    await callSessions.openWithPending({
      participants: [CHRIS, AWA],
      inviteeId: SAMUEL,
      byUserId: NADIA,
    }),
    null,
    'aucun second ajout après consommation',
  );

  // ── Départ d'un des trois : les deux autres continuent ──────────────────────
  const afterLeave = await callSessions.removeParticipant(live.sessionId, CHRIS);
  assert.strictEqual(afterLeave.destroyed, false, 'session survit à deux');
  assert.strictEqual(afterLeave.wasPending, false);
  assert.deepStrictEqual(afterLeave.remaining.sort((a, b) => a - b), [AWA, NADIA]);
  assert.strictEqual(await callSessions.hasAddRight(CHRIS), true, 'le partant retrouve son droit');

  // Point clé de la spécification : le droit reste CONSOMMÉ pour les restants,
  // alors même qu'ils ne sont plus que deux.
  assert.strictEqual((await callSessions.get(live.sessionId)).addRight, 'consumed');
  for (const uid of [AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), false, `droit toujours consommé pour ${uid}`);
  }

  // ── Le second départ vide la session ────────────────────────────────────────
  const afterSecond = await callSessions.removeParticipant(live.sessionId, AWA);
  assert.strictEqual(afterSecond.destroyed, true, 'session détruite sous deux participants');
  assert.strictEqual(await callSessions.get(live.sessionId), null);
  assert.strictEqual(await callSessions.hasAddRight(NADIA), true, 'droit rendu au dernier');

  // ── Retirer l'invité qui sonnait encore = échec d'invitation ────────────────
  callSessions._reset();
  const ringing = await openDefault();
  const droppedInvitee = await callSessions.removeParticipant(ringing.sessionId, NADIA);
  assert.strictEqual(droppedInvitee.wasPending, true);
  assert.strictEqual(droppedInvitee.destroyed, true);
  assert.deepStrictEqual(droppedInvitee.remaining.sort((a, b) => a - b), [CHRIS, AWA]);
  for (const uid of [CHRIS, AWA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
  }

  // ── Le départ de l'invitant pendant la sonnerie annule l'invitation ─────────
  callSessions._reset();
  const cancelled = await openDefault();
  const afterHostLeft = await callSessions.removeParticipant(cancelled.sessionId, CHRIS);
  assert.strictEqual(afterHostLeft.destroyed, true, 'plus de session sous deux participants');
  assert.strictEqual(await callSessions.hasAddRight(NADIA), true, 'invité libéré');
  assert.strictEqual(await callSessions.hasAddRight(AWA), true);

  // ── Entrées invalides ───────────────────────────────────────────────────────
  callSessions._reset();
  assert.strictEqual(
    await callSessions.openWithPending({ participants: [CHRIS, AWA], inviteeId: AWA, byUserId: CHRIS }),
    null,
    "l'invité ne peut pas déjà être dans l'appel",
  );
  assert.strictEqual(
    await callSessions.openWithPending({ participants: [CHRIS, AWA], inviteeId: NADIA, byUserId: SAMUEL }),
    null,
    'seul un participant peut inviter',
  );
  assert.strictEqual(
    await callSessions.openWithPending({ participants: [CHRIS], inviteeId: NADIA, byUserId: CHRIS }),
    null,
    'il faut deux participants au départ',
  );
  assert.strictEqual(
    await callSessions.openWithPending({ participants: [CHRIS, AWA], inviteeId: null, byUserId: CHRIS }),
    null,
    'invité obligatoire',
  );

  // ── Le délai d'invitation est nettoyé à la destruction ──────────────────────
  callSessions._reset();
  let fired = false;
  const timed = await openDefault();
  await callSessions.armPendingTimer(timed.sessionId, 5, () => { fired = true; });
  await callSessions.abortPending(timed.sessionId);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(fired, false, "le délai d'invitation ne survit pas à la session");

  console.log('✅ callSessions.test.js — tous les cas passent');
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
