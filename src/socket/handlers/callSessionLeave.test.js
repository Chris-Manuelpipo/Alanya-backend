// « Raccrocher = partir » : un départ d'une session à trois ne doit jamais
// emporter l'appel des autres. Couvre les trois branches de leaveCallSession
// (invité qui sonnait encore, session qui survit à deux, dernier participant)
// ainsi que la solde d'une invitation par failInvite.
//
// Les callId sont volontairement laissés à null : closeCallHistory sort alors
// immédiatement et le test n'a besoin d'aucune base de données.
const assert = require('assert');
const { leaveCallSession, failInvite } = require('./calls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const pendingCalls = require('../state/pendingCalls');
const { makeFakeIo, fakeSocket } = require('../../testUtils/fakeIo');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;

// io factice : capture les événements émis par utilisateur (via .to().emit(),
// toujours local — l'adapter le propage cross-instance sans changement de
// code) + délègue fetchSockets() cross-instance à makeFakeIo pour
// emitToUserExceptDevice (async depuis l'intégration Redis phase 1).
function fakeIo(extraSockets = []) {
  const sent = [];
  const base = makeFakeIo(extraSockets);

  return {
    sent,
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
          base.to(room).emit(event, payload);
        },
      };
    },
    in: base.in,
    eventsFor(userId) {
      return sent.filter((e) => e.room === `user_${userId}`).map((e) => e.event);
    },
    payloadFor(userId, event) {
      return sent.find((e) => e.room === `user_${userId}` && e.event === event)?.payload;
    },
    sockets: base.sockets,
  };
}

function deviceSocket(id, userId, deviceId) {
  return fakeSocket(id, { userId, deviceId });
}

function reset() {
  [CHRIS, AWA, NADIA].forEach((id) => {
    callState.clear(id);
    pendingCalls.clear(id);
  });
  callSessions._reset();
}

/** Appel à deux établi entre Chris et Awa. */
function twoWayCall() {
  callState.setInCall(CHRIS, { peerId: AWA });
  callState.setInCall(AWA, { peerId: CHRIS });
}

/** Session à trois complète (Nadia entrée). */
function threeWaySession() {
  twoWayCall();
  const s = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
  });
  callSessions.promotePending(s.sessionId);
  callState.setInCall(NADIA, { peerId: CHRIS });
  return s;
}

(async () => {
  // ── Sans session : leaveCallSession ne s'en mêle pas ────────────────────────
  reset();
  twoWayCall();
  assert.strictEqual(
    await leaveCallSession(fakeIo(), null, CHRIS, 'hangup'),
    false,
    'appel 1-à-1 ordinaire : chemin nominal inchangé',
  );
  assert.strictEqual(callState.get(CHRIS), 'in_call', 'aucun état touché');

  // ── L'invité raccroche pendant qu'il sonne = refus ──────────────────────────
  reset();
  twoWayCall();
  const ringing = callSessions.openWithPending({
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
  });
  callState.setRinging(NADIA, { peerId: CHRIS });

  let io = fakeIo();
  assert.strictEqual(await leaveCallSession(io, null, NADIA, 'hangup'), true);
  assert.deepStrictEqual(io.eventsFor(CHRIS), ['call_conf_failed']);
  assert.deepStrictEqual(io.eventsFor(AWA), ['call_conf_failed']);
  assert.strictEqual(io.payloadFor(CHRIS, 'call_conf_failed').reason, 'declined');
  // Les deux présents n'ont jamais quitté leur appel : rien ne doit y toucher.
  assert.strictEqual(callState.get(CHRIS), 'in_call', 'Chris toujours en appel');
  assert.strictEqual(callState.get(AWA), 'in_call', 'Awa toujours en appel');
  assert.strictEqual(callState.get(NADIA), 'idle', 'invité libéré');
  assert.strictEqual(callSessions.hasAddRight(CHRIS), true, 'droit rendu');
  assert.strictEqual(callSessions.hasAddRight(AWA), true, 'droit rendu à l\'autre aussi');

  // Une déconnexion, elle, est signalée comme telle.
  reset();
  twoWayCall();
  callSessions.openWithPending({
    participants: [CHRIS, AWA], inviteeId: NADIA, byUserId: CHRIS,
  });
  callState.setRinging(NADIA, { peerId: CHRIS });
  io = fakeIo();
  await leaveCallSession(io, null, NADIA, 'disconnect');
  assert.strictEqual(io.payloadFor(CHRIS, 'call_conf_failed').reason, 'offline');

  // ── Départ d'un des trois : les deux autres continuent ──────────────────────
  reset();
  const live = threeWaySession();
  io = fakeIo();
  assert.strictEqual(await leaveCallSession(io, null, CHRIS, 'hangup'), true);

  assert.deepStrictEqual(io.eventsFor(AWA), ['call_conf_left'], 'Awa informée du départ');
  assert.deepStrictEqual(io.eventsFor(NADIA), ['call_conf_left'], 'Nadia informée du départ');
  assert.strictEqual(io.eventsFor(CHRIS).length, 0, 'le partant ne reçoit rien');
  // Surtout pas de call_ended : l'appel continue.
  assert.ok(!io.sent.some((e) => e.event === 'call_ended'), 'aucune fin d\'appel émise');

  const leftPayload = io.payloadFor(AWA, 'call_conf_left');
  assert.strictEqual(leftPayload.userId, String(CHRIS));
  assert.deepStrictEqual(leftPayload.remaining.map(Number).sort((a, b) => a - b), [AWA, NADIA]);

  assert.strictEqual(callState.get(CHRIS), 'idle', 'le partant repasse idle');
  assert.strictEqual(callState.get(AWA), 'in_call', 'Awa toujours en communication');
  assert.strictEqual(callState.get(NADIA), 'in_call', 'Nadia toujours en communication');
  // Les deux restants se désignent mutuellement, sans quoi la prochaine fin
  // d'appel ou le prochain « occupé » viserait quelqu'un qui n'est plus là.
  assert.strictEqual(Number(callState.getEntry(AWA).peerId), NADIA, 'Awa pointe Nadia');
  assert.strictEqual(Number(callState.getEntry(NADIA).peerId), AWA, 'Nadia pointe Awa');
  // Le droit d'ajout reste consommé bien qu'ils ne soient plus que deux.
  assert.strictEqual(callSessions.hasAddRight(AWA), false, 'droit toujours consommé');
  assert.strictEqual(callSessions.hasAddRight(NADIA), false, 'droit toujours consommé');
  assert.strictEqual(callSessions.get(live.sessionId).addRight, 'consumed');

  // ── 2ᵉ leave après hangup : no-op (filet anti double end_call CallKit) ──────
  // Le client peut renvoyer end_call ; leaveCallSession doit renvoyer false et
  // l'émetteur doit rester idle sans toucher Awa/Nadia.
  io = fakeIo();
  assert.strictEqual(await leaveCallSession(io, null, CHRIS, 'hangup'), false);
  assert.strictEqual(callState.get(CHRIS), 'idle');
  assert.strictEqual(callState.get(AWA), 'in_call');
  assert.strictEqual(callState.get(NADIA), 'in_call');
  assert.ok(!io.sent.some((e) => e.event === 'call_ended'), '2ᵉ leave : pas de call_ended');
  assert.ok(!io.sent.some((e) => e.event === 'call_conf_left'), '2ᵉ leave : pas de conf_left');

  // ── Le second départ termine réellement l'appel ─────────────────────────────
  io = fakeIo();
  assert.strictEqual(await leaveCallSession(io, null, AWA, 'hangup'), true);
  assert.deepStrictEqual(io.eventsFor(NADIA), ['call_ended'], 'le dernier voit l\'appel finir');
  assert.strictEqual(callState.get(NADIA), 'idle');
  assert.strictEqual(callSessions.get(live.sessionId), null, 'session détruite');
  assert.strictEqual(callSessions.hasAddRight(NADIA), true);

  // ── failInvite : solde l'invitation et rend le droit ────────────────────────
  reset();
  twoWayCall();
  const pending = callSessions.openWithPending({
    participants: [CHRIS, AWA], inviteeId: NADIA, byUserId: CHRIS,
  });
  callState.setRinging(NADIA, { peerId: CHRIS });

  io = fakeIo();
  await failInvite(io, pending.sessionId, 'no_answer');
  assert.strictEqual(io.payloadFor(CHRIS, 'call_conf_failed').reason, 'no_answer');
  assert.strictEqual(io.payloadFor(AWA, 'call_conf_failed').reason, 'no_answer');
  // L'invité qui n'a pas répondu doit voir sa sonnerie coupée.
  assert.deepStrictEqual(io.eventsFor(NADIA), ['call_ended'], 'sonnerie de l\'invité coupée');
  assert.strictEqual(callState.get(NADIA), 'idle');
  assert.strictEqual(callState.get(CHRIS), 'in_call', 'appel des présents intact');
  assert.strictEqual(callSessions.hasAddRight(CHRIS), true, 'droit rendu après échec');

  // Refus explicite multi-device : C1 refuse → C2 reçoit call_ended, C1 exclu.
  reset();
  twoWayCall();
  const declined = callSessions.openWithPending({
    participants: [CHRIS, AWA], inviteeId: NADIA, byUserId: CHRIS,
  });
  callState.setRinging(NADIA, { peerId: CHRIS });
  const c1 = deviceSocket('c1', NADIA, 'dev-C1');
  const c2 = deviceSocket('c2', NADIA, 'dev-C2');
  io = fakeIo([c1, c2]);
  await failInvite(io, declined.sessionId, 'declined', { decliningDeviceId: 'dev-C1' });
  assert.strictEqual(io.payloadFor(CHRIS, 'call_conf_failed').reason, 'declined');
  assert.strictEqual(c1.events.length, 0, 'C1 (refuseur) exclu du stop distant');
  assert.strictEqual(c2.events.length, 1, 'C2 reçoit call_ended');
  assert.strictEqual(c2.events[0].event, 'call_ended');
  assert.strictEqual(c2.events[0].payload.reason, 'rejected_elsewhere');
  assert.strictEqual(c2.events[0].payload.claimedByAnotherDevice, true);
  assert.strictEqual(callState.get(NADIA), 'idle');
  assert.strictEqual(callSessions.hasAddRight(CHRIS), true, 'droit rendu après refus');

  reset();
  console.log('✅ callSessionLeave.test.js — tous les cas passent');
  process.exit(0);
})().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
