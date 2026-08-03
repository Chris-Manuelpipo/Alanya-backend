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

// ── Droit d'ajout disponible tant qu'aucune session n'existe ──────────────────
callSessions._reset();
assert.strictEqual(callSessions.hasAddRight(CHRIS), true, 'droit dispo au départ');
assert.strictEqual(callSessions.getByUser(CHRIS), null, 'pas de session au départ');

// ── Ouverture : verrouille le droit pour les trois ────────────────────────────
const session = openDefault();
assert.ok(session, 'session créée');
assert.strictEqual(session.addRight, 'locked');
assert.strictEqual(session.participants.size, 2, 'invité pas encore participant');
assert.strictEqual(session.pending.userId, NADIA);
assert.strictEqual(session.pending.byUserId, CHRIS);
assert.strictEqual(session.originCallId, '77');
for (const uid of [CHRIS, AWA, NADIA]) {
  assert.strictEqual(callSessions.hasAddRight(uid), false, `droit verrouillé pour ${uid}`);
  assert.strictEqual(callSessions.getByUser(uid)?.sessionId, session.sessionId);
}
assert.strictEqual(callSessions.isPending(session, NADIA), true);
assert.strictEqual(callSessions.isPending(session, AWA), false);
assert.deepStrictEqual(callSessions.peersOf(session, CHRIS), [AWA]);

// ── Course : le second appui repart bredouille ────────────────────────────────
const loser = callSessions.openWithPending({
  originCallId: 77,
  participants: [CHRIS, AWA],
  inviteeId: SAMUEL,
  byUserId: AWA,
});
assert.strictEqual(loser, null, 'un seul ajout par appel');

// ── Échec de l'invitation : le droit revient AUX DEUX ─────────────────────────
const aborted = callSessions.abortPending(session.sessionId);
assert.strictEqual(aborted, NADIA, 'invité retiré');
assert.strictEqual(callSessions.get(session.sessionId), null, 'session détruite');
for (const uid of [CHRIS, AWA, NADIA]) {
  assert.strictEqual(callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
}

// ── Une nouvelle tentative est alors possible, y compris par l'autre ──────────
const retry = callSessions.openWithPending({
  originCallId: 77,
  participants: [CHRIS, AWA],
  inviteeId: SAMUEL,
  byUserId: AWA,
});
assert.ok(retry, 'nouvelle tentative autorisée après échec');
callSessions.abortPending(retry.sessionId);

// ── Acceptation : droit consommé, trois participants ──────────────────────────
callSessions._reset();
const live = openDefault();
const promoted = callSessions.promotePending(live.sessionId);
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
  assert.strictEqual(callSessions.hasAddRight(uid), false, `droit consommé pour ${uid}`);
}
assert.strictEqual(
  callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: SAMUEL,
    byUserId: NADIA,
  }),
  null,
  'aucun second ajout après consommation',
);

// ── Départ d'un des trois : les deux autres continuent ────────────────────────
const afterLeave = callSessions.removeParticipant(live.sessionId, CHRIS);
assert.strictEqual(afterLeave.destroyed, false, 'session survit à deux');
assert.strictEqual(afterLeave.wasPending, false);
assert.deepStrictEqual(afterLeave.remaining.sort((a, b) => a - b), [AWA, NADIA]);
assert.strictEqual(callSessions.hasAddRight(CHRIS), true, 'le partant retrouve son droit');

// Point clé de la spécification : le droit reste CONSOMMÉ pour les restants,
// alors même qu'ils ne sont plus que deux.
assert.strictEqual(callSessions.get(live.sessionId).addRight, 'consumed');
for (const uid of [AWA, NADIA]) {
  assert.strictEqual(callSessions.hasAddRight(uid), false, `droit toujours consommé pour ${uid}`);
}

// ── Le second départ vide la session ──────────────────────────────────────────
const afterSecond = callSessions.removeParticipant(live.sessionId, AWA);
assert.strictEqual(afterSecond.destroyed, true, 'session détruite sous deux participants');
assert.strictEqual(callSessions.get(live.sessionId), null);
assert.strictEqual(callSessions.hasAddRight(NADIA), true, 'droit rendu au dernier');

// ── Retirer l'invité qui sonnait encore = échec d'invitation ──────────────────
callSessions._reset();
const ringing = openDefault();
const droppedInvitee = callSessions.removeParticipant(ringing.sessionId, NADIA);
assert.strictEqual(droppedInvitee.wasPending, true);
assert.strictEqual(droppedInvitee.destroyed, true);
assert.deepStrictEqual(droppedInvitee.remaining.sort((a, b) => a - b), [CHRIS, AWA]);
for (const uid of [CHRIS, AWA]) {
  assert.strictEqual(callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
}

// ── Le départ de l'invitant pendant la sonnerie annule l'invitation ───────────
callSessions._reset();
const cancelled = openDefault();
const afterHostLeft = callSessions.removeParticipant(cancelled.sessionId, CHRIS);
assert.strictEqual(afterHostLeft.destroyed, true, 'plus de session sous deux participants');
assert.strictEqual(callSessions.hasAddRight(NADIA), true, 'invité libéré');
assert.strictEqual(callSessions.hasAddRight(AWA), true);

// ── Entrées invalides ─────────────────────────────────────────────────────────
callSessions._reset();
assert.strictEqual(
  callSessions.openWithPending({ participants: [CHRIS, AWA], inviteeId: AWA, byUserId: CHRIS }),
  null,
  "l'invité ne peut pas déjà être dans l'appel",
);
assert.strictEqual(
  callSessions.openWithPending({ participants: [CHRIS, AWA], inviteeId: NADIA, byUserId: SAMUEL }),
  null,
  "seul un participant peut inviter",
);
assert.strictEqual(
  callSessions.openWithPending({ participants: [CHRIS], inviteeId: NADIA, byUserId: CHRIS }),
  null,
  'il faut deux participants au départ',
);
assert.strictEqual(
  callSessions.openWithPending({ participants: [CHRIS, AWA], inviteeId: null, byUserId: CHRIS }),
  null,
  'invité obligatoire',
);

// ── Le timer d'expiration est nettoyé à la destruction ────────────────────────
callSessions._reset();
let fired = false;
const timed = openDefault({ timer: setTimeout(() => { fired = true; }, 5) });
callSessions.abortPending(timed.sessionId);
setTimeout(() => {
  assert.strictEqual(fired, false, "le timer d'invitation ne survit pas à la session");
  console.log('✅ callSessions.test.js — tous les cas passent');
}, 30);
