// Sessions d'appel à trois — droit d'ajout, greffe, promotion, départs.
//
// Le store est async depuis la migration Redis : ces tests exercent le repli
// mémoire (aucun REDIS_URL ici). L'atomicité réelle de `openWithPending` et de
// `addPending` se vérifie contre un vrai Redis dans callSessions.race.test.js —
// en mémoire, JS étant mono-thread, elle est acquise d'office et ne prouverait
// rien.
const assert = require('assert');
const callSessions = require('./callSessions');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;
const SAMUEL = 4;
const PAUL = 5;

const openDefault = (overrides = {}) =>
  callSessions.openWithPending({
    originCallId: 77,
    isVideo: false,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    ...overrides,
  });

// Awa parle à Chris, Chris fait entrer Nadia, puis Chris s'en va : la session
// reste, portée par Awa et Nadia, sans invitation en vol.
const sessionRetombeeADeux = async () => {
  const s = await openDefault();
  await callSessions.promotePending(s.sessionId);
  await callSessions.removeParticipant(s.sessionId, CHRIS);
  return s.sessionId;
};

(async () => {
  // ── Droit d'ajout disponible tant qu'aucune session n'existe ────────────────
  callSessions._reset();
  assert.strictEqual(await callSessions.hasAddRight(CHRIS), true, 'droit dispo au départ');
  assert.strictEqual(await callSessions.getByUser(CHRIS), null, 'pas de session au départ');

  // ── Ouverture : verrouille le droit pour les trois ──────────────────────────
  const session = await openDefault();
  assert.ok(session, 'session créée');
  assert.strictEqual(session.addRight, 'locked');
  assert.strictEqual(session.joins, 0, 'personne encore entré');
  assert.strictEqual(session.invites, 1);
  assert.strictEqual(
    session.pending.inviteId,
    session.sessionId,
    "la première invitation garde le sessionId : les apps installées l'attendent",
  );
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
  assert.strictEqual(loser, null, 'une seule invitation en vol');

  // ── Échec de la première invitation : la session disparaît, le droit revient
  //    AUX DEUX ─────────────────────────────────────────────────────────────────
  const aborted = await callSessions.abortPending(session.sessionId);
  assert.deepStrictEqual(aborted, { inviteeId: NADIA, destroyed: true }, 'invité retiré, session détruite');
  assert.strictEqual(await callSessions.get(session.sessionId), null, 'session détruite');
  for (const uid of [CHRIS, AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
  }
  assert.strictEqual(await callSessions.abortPending(session.sessionId), null, 'rien à solder deux fois');

  // ── Une nouvelle tentative est alors possible, y compris par l'autre ────────
  const retry = await callSessions.openWithPending({
    originCallId: 77,
    participants: [CHRIS, AWA],
    inviteeId: SAMUEL,
    byUserId: AWA,
  });
  assert.ok(retry, 'nouvelle tentative autorisée après échec');
  await callSessions.abortPending(retry.sessionId);

  // ── Acceptation : trois participants, droit épuisé ──────────────────────────
  callSessions._reset();
  const live = await openDefault();
  const promoted = await callSessions.promotePending(live.sessionId);
  assert.ok(promoted, 'invité promu');
  assert.strictEqual(promoted.addRight, 'consumed');
  assert.strictEqual(promoted.joins, 1, 'une entrée');
  assert.strictEqual(promoted.pending, null);
  assert.strictEqual(promoted.participants.size, 3);
  assert.deepStrictEqual(
    callSessions.participantIds(promoted).sort((a, b) => a - b),
    [CHRIS, AWA, NADIA],
  );
  assert.strictEqual(callSessions.isPending(promoted, NADIA), false);

  // À trois, personne ne peut ajouter, l'invité pas davantage que les autres.
  for (const uid of [CHRIS, AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), false, `appel plein pour ${uid}`);
  }
  assert.strictEqual(
    await callSessions.openWithPending({
      participants: [CHRIS, AWA],
      inviteeId: SAMUEL,
      byUserId: NADIA,
    }),
    null,
    'pas de seconde session sur un appel en cours',
  );
  assert.deepStrictEqual(
    await callSessions.addPending(live.sessionId, { inviteeId: SAMUEL, byUserId: NADIA }),
    { refus: 'FULL' },
    'pas de quatrième',
  );

  // ── Départ d'un des trois : les deux autres continuent ──────────────────────
  const afterLeave = await callSessions.removeParticipant(live.sessionId, CHRIS);
  assert.strictEqual(afterLeave.destroyed, false, 'session survit à deux');
  assert.strictEqual(afterLeave.wasPending, false);
  assert.deepStrictEqual(afterLeave.remaining.sort((a, b) => a - b), [AWA, NADIA]);
  assert.strictEqual(await callSessions.hasAddRight(CHRIS), true, 'le partant retrouve son droit');

  // Point clé (docs/transfert_appel.md § 4.5) : retombés à deux, les restants
  // retrouvent le droit — l'ancien invité compris.
  assert.strictEqual((await callSessions.get(live.sessionId)).addRight, 'available');
  for (const uid of [AWA, NADIA]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
  }

  // ── Le second départ vide la session ────────────────────────────────────────
  const afterSecond = await callSessions.removeParticipant(live.sessionId, AWA);
  assert.strictEqual(afterSecond.destroyed, true, 'session détruite sous deux participants');
  assert.strictEqual(await callSessions.get(live.sessionId), null);
  assert.strictEqual(await callSessions.hasAddRight(NADIA), true, 'droit rendu au dernier');

  // ── Greffe : retombés à deux, les restants invitent à nouveau ───────────────
  callSessions._reset();
  const sid = await sessionRetombeeADeux();
  const greffe = await callSessions.addPending(sid, { inviteeId: SAMUEL, byUserId: NADIA, mode: 'transfer' });
  assert.ok(greffe.session, `greffe acceptée (${greffe.refus})`);
  assert.strictEqual(greffe.session.sessionId, sid, 'même session');
  assert.strictEqual(greffe.session.pending.userId, SAMUEL);
  assert.strictEqual(greffe.session.pending.byUserId, NADIA);
  assert.strictEqual(greffe.session.pending.inviteId, `${sid}_r2`, 'identifiant propre au second tour');
  assert.strictEqual(greffe.session.addRight, 'locked');
  assert.strictEqual(greffe.session.mode, 'transfer');
  assert.deepStrictEqual(
    {
      initiatorId: greffe.session.transfer.initiatorId,
      targetId: greffe.session.transfer.targetId,
      state: greffe.session.transfer.state,
    },
    { initiatorId: NADIA, targetId: SAMUEL, state: 'pending' },
    "transfert neuf, lancé par l'ancien invité",
  );
  assert.strictEqual((await callSessions.getByUser(SAMUEL))?.sessionId, sid, 'invité rattaché à la session');
  for (const uid of [AWA, NADIA, SAMUEL]) {
    assert.strictEqual(await callSessions.hasAddRight(uid), false, `droit verrouillé pour ${uid}`);
  }

  // Deux appuis : le second repart bredouille.
  assert.deepStrictEqual(
    await callSessions.addPending(sid, { inviteeId: PAUL, byUserId: AWA }),
    { refus: 'PENDING' },
    'une seule invitation en vol par session',
  );

  // ── Échec de la greffe : la session survit, seul l'invité est retiré ────────
  const soldee = await callSessions.abortPending(sid);
  assert.deepStrictEqual(soldee, { inviteeId: SAMUEL, destroyed: false }, 'session gardée');
  const gardee = await callSessions.get(sid);
  assert.ok(gardee, "la session porte toujours l'appel");
  assert.strictEqual(gardee.pending, null);
  assert.strictEqual(gardee.mode, 'join');
  assert.strictEqual(gardee.transfer, null);
  assert.strictEqual(gardee.addRight, 'available');
  assert.deepStrictEqual(callSessions.participantIds(gardee).sort((a, b) => a - b), [AWA, NADIA]);
  assert.strictEqual(await callSessions.getByUser(SAMUEL), null, 'invité libéré');
  for (const uid of [AWA, NADIA]) {
    assert.strictEqual((await callSessions.getByUser(uid))?.sessionId, sid, `${uid} toujours dans la session`);
    assert.strictEqual(await callSessions.hasAddRight(uid), true, `droit rendu à ${uid}`);
  }

  // Une nouvelle greffe passe, sous un nouvel identifiant : Samuel, qui vient
  // de refuser, peut être relancé sans retomber sur la marque de son refus.
  const relance = await callSessions.addPending(sid, { inviteeId: SAMUEL, byUserId: AWA });
  assert.strictEqual(relance.session.pending.inviteId, `${sid}_r3`);
  assert.strictEqual(relance.session.mode, 'join');
  assert.strictEqual(relance.session.transfer, null);

  // Il entre : trois présents, deuxième entrée.
  const trois = await callSessions.promotePending(sid);
  assert.strictEqual(trois.participants.size, 3);
  assert.strictEqual(trois.joins, 2);
  assert.strictEqual(trois.addRight, 'consumed');

  // ── L'invité greffé raccroche en sonnant : la session reste à deux ──────────
  callSessions._reset();
  const sid2 = await sessionRetombeeADeux();
  await callSessions.addPending(sid2, { inviteeId: SAMUEL, byUserId: AWA });
  const invitePart = await callSessions.removeParticipant(sid2, SAMUEL);
  assert.strictEqual(invitePart.wasPending, true);
  assert.strictEqual(invitePart.destroyed, false, 'la session greffée survit');
  assert.ok(await callSessions.get(sid2));
  assert.strictEqual(await callSessions.getByUser(SAMUEL), null);

  // ── Un présent part pendant la sonnerie greffée : plus assez de monde ───────
  await callSessions.addPending(sid2, { inviteeId: SAMUEL, byUserId: AWA });
  const presentPart = await callSessions.removeParticipant(sid2, AWA);
  assert.strictEqual(presentPart.destroyed, true, 'session détruite sous deux présents');
  assert.strictEqual(presentPart.hadPendingInvitee, SAMUEL, "l'invité en attente est signalé pour être coupé");
  assert.strictEqual(await callSessions.getByUser(SAMUEL), null, 'invité libéré');
  assert.strictEqual(await callSessions.getByUser(NADIA), null);

  // ── Refus de greffe ─────────────────────────────────────────────────────────
  callSessions._reset();
  const sid3 = await sessionRetombeeADeux();
  assert.deepStrictEqual(
    await callSessions.addPending(sid3, { inviteeId: AWA, byUserId: NADIA }),
    { refus: 'INVALID' },
    'invité déjà présent',
  );
  assert.deepStrictEqual(
    await callSessions.addPending(sid3, { inviteeId: NADIA, byUserId: NADIA }),
    { refus: 'INVALID' },
    "s'inviter soi-même",
  );
  assert.deepStrictEqual(
    await callSessions.addPending(sid3, { inviteeId: SAMUEL, byUserId: CHRIS }),
    { refus: 'SESSION_GONE' },
    'le partant ne peut plus inviter',
  );
  assert.deepStrictEqual(
    await callSessions.addPending('conf_inconnue', { inviteeId: SAMUEL, byUserId: AWA }),
    { refus: 'SESSION_GONE' },
  );
  // Samuel sonne déjà pour un autre appel.
  await callSessions.openWithPending({ participants: [10, 11], inviteeId: SAMUEL, byUserId: 10 });
  assert.deepStrictEqual(
    await callSessions.addPending(sid3, { inviteeId: SAMUEL, byUserId: AWA }),
    { refus: 'TARGET_BUSY' },
  );
  assert.strictEqual((await callSessions.get(sid3)).pending, null, 'un refus ne laisse aucune invitation');

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

  // ── … et quand l'échec d'une greffe garde la session ────────────────────────
  callSessions._reset();
  let firedKept = false;
  const sid4 = await sessionRetombeeADeux();
  await callSessions.addPending(sid4, { inviteeId: SAMUEL, byUserId: AWA });
  await callSessions.armPendingTimer(sid4, 5, () => { firedKept = true; });
  await callSessions.abortPending(sid4);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(firedKept, false, "le délai d'une invitation soldée ne survit pas, même si la session reste");

  console.log('✅ callSessions.test.js — tous les cas passent');
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
