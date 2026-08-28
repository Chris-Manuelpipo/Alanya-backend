// Un refus d'invitation en conférence ne doit pas raccrocher l'appel de
// l'inviteur. Entrée E1 de l'audit — la seule dont l'effet sortait de
// l'appareil fautif.
//
// La couche native ne connaît que POST /calls/reject : elle n'a jamais su
// qu'une conférence existait. Quand CallKit retire une invitation restée sans
// réponse — à 40 s, avant le timer serveur de 45 s —, c'est un refus 1-à-1
// qu'elle poste, avec un identifiant de session que `toInt` ne sait pas lire.
// Le refus était alors traité comme celui d'un appel simple : état serveur de
// l'inviteur effacé, `call_rejected` émis vers lui, appel en cours raccroché.
const assert = require('assert');
const pool = require('../../config/db');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const callSessions = require('../state/callSessions');
const { processRejectCall } = require('./calls');

const A = 801; // inviteur, en appel avec B
const B = 802; // pair d'origine
const C = 803; // invité qui ne répond pas
const D = 804; // tiers sans rapport
const CALL_AB = 4242;

async function reset() {
  for (const id of [A, B, C, D]) await callState.clear(id);
  await callDeviceOwnership.release(String(CALL_AB));
  if (callSessions._reset) callSessions._reset();
}

/// A et B sont en communication depuis `call_answered`.
async function callInProgress() {
  await callState.setInCall(A, { callId: CALL_AB, peerId: B, isVideo: false });
  await callState.setInCall(B, { callId: CALL_AB, peerId: A, isVideo: false });
}

const fakeIo = () => {
  const emits = [];
  return {
    sockets: { adapter: { rooms: new Map() } },
    in: () => ({ fetchSockets: async () => [] }),
    to(room) {
      return { emit(event, payload) { emits.push({ room, event, payload }); } };
    },
    get emits() { return emits; },
  };
};

async function main() {
  const userSockets = new Map();

  // ── 1) Invitation non répondue : l'appel A↔B survit ──────────────────────
  await reset();
  await callInProgress();
  const session = await callSessions.openWithPending({
    originCallId: CALL_AB,
    isVideo: false,
    participants: [A, B],
    inviteeId: C,
    byUserId: A,
  });
  assert.ok(session, 'session à trois ouverte');

  const io = fakeIo();
  const result = await processRejectCall({
    io,
    userSockets,
    callerID: A,               // ce que poste la couche native
    receiverID: C,
    callIdHint: session.sessionId, // « conf_4242_1 » — toInt() rend null
  });

  assert.strictEqual(result.conference, true, 'refus reconnu comme une invitation');

  const entryA = await callState.getEntry(A);
  assert.ok(entryA, "l'état de l'inviteur n'a pas été effacé");
  assert.strictEqual(entryA.status, 'in_call', 'il est toujours en communication');
  assert.strictEqual(String(entryA.peerId), String(B), 'toujours avec le même pair');

  const entryB = await callState.getEntry(B);
  assert.ok(entryB && entryB.status === 'in_call', "le pair n'a pas été soldé non plus");

  assert.strictEqual(
    io.emits.filter((e) => e.event === 'call_rejected').length, 0,
    "aucun call_rejected vers l'inviteur — c'est lui qui raccrochait",
  );

  // ── 2) Un refus 1-à-1 ordinaire fonctionne toujours ──────────────────────
  await reset();
  await callState.setRinging(C, { callId: CALL_AB, peerId: A, isVideo: false });
  await callState.setRinging(A, { callId: CALL_AB, peerId: C, isVideo: false });

  const io2 = fakeIo();
  const res2 = await processRejectCall({
    io: io2,
    userSockets,
    callerID: A,
    receiverID: C,
    callIdHint: CALL_AB,
  });
  assert.strictEqual(res2.ok, true, 'refus ordinaire accepté');
  assert.ok(!res2.conference, 'pas de route conférence ici');
  assert.strictEqual(
    io2.emits.filter((e) => e.event === 'call_rejected').length, 1,
    "l'appelant est prévenu, comme avant",
  );
  assert.strictEqual(await callState.getEntry(A), null, 'son état est soldé');

  // ── 3) Refus tardif d'un tiers : l'appel en cours est intouchable ─────────
  // La session a déjà été nettoyée (timer serveur passé), donc la route
  // conférence ne joue plus. C'est le second filet qui protège.
  await reset();
  await callInProgress();

  const io3 = fakeIo();
  await processRejectCall({
    io: io3,
    userSockets,
    callerID: A,
    receiverID: D,          // un tiers avec qui A n'est pas en communication
    callIdHint: 'conf_4242_9',
  });

  const entryA3 = await callState.getEntry(A);
  assert.ok(entryA3 && entryA3.status === 'in_call', "l'appel de A tient");
  assert.strictEqual(String(entryA3.peerId), String(B), 'et toujours avec B');
  assert.strictEqual(
    io3.emits.filter((e) => e.event === 'call_rejected').length, 0,
    'et personne ne lui dit de raccrocher',
  );

  await reset();
  console.log('conferenceRejectRouting.test.js OK');
  // Le pool MySQL garde ses connexions : sans cette libération, le
  // processus ne rend pas la main — voir C6.
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
