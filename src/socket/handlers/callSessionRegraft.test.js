// Transfert en cascade : retombés à deux, les restants ajoutent ou transfèrent
// à nouveau dans la même session (docs/transfert_appel.md § 4.5).
//
// Handlers réels — call_add_participant, call_conf_join, leaveCallSession,
// failInvite — sur le repli mémoire des états. La base est neutralisée : le
// blocage, les fiches et l'historique la consultent, et ce test porte sur la
// session, pas sur eux. Les notifications sont capturées, pour vérifier quel
// identifiant atteint le téléphone de chacun.
const assert = require('assert');

// ── Doublures, posées AVANT de charger calls.js, qui fige ses imports ────────
const pool = require('../../config/db');
const sansLignes = async () => [[], []];
pool.query = sansLignes;
pool.execute = sansLignes;
pool.getConnection = async () => ({
  query: sansLignes,
  execute: sansLignes,
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release: () => {},
});

const blocages = new Set();
const blockUtils = require('../../utils/blockUtils');
blockUtils.isBlockedEitherWay = async (a, b) =>
  blocages.has(`${a}:${b}`) || blocages.has(`${b}:${a}`);

const invitationsPoussees = [];
const finsPoussees = [];
const notifications = require('../../services/notificationService');
notifications.notifyIncomingCall = async (...args) => { invitationsPoussees.push(args); };
notifications.notifyCallEnded = async (...args) => { finsPoussees.push(args); };

const { addParticipant, confJoin, leaveCallSession, failInvite } = require('./calls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const pendingCalls = require('../state/pendingCalls');
const { makeFakeIo } = require('../../testUtils/fakeIo');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;
const SAMUEL = 4;
const PAUL = 5;
const TOUS = [CHRIS, AWA, NADIA, SAMUEL, PAUL];
const ORIGIN = 77;

const appareil = (uid) => `appareil-${uid}`;

function fakeIo() {
  const sent = [];
  const base = makeFakeIo([]);
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
    sockets: base.sockets,
    /** Charges de [event] reçues par [userId], sur son compte ou l'un de ses appareils. */
    pour(userId, event) {
      return sent
        .filter((e) => e.event === event
          && (e.room === `user_${userId}` || e.room.startsWith(`user_${userId}_device_`)))
        .map((e) => e.payload);
    },
  };
}

function socketDe(userId) {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock-${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: appareil(userId),
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    async trigger(event, data) { await handlers[event](data); },
    emitted,
  };
}

/** Rend les codes de refus reçus par le demandeur — vide si l'ajout est parti. */
async function ajouter(io, userId, cible, mode = 'join') {
  const s = socketDe(userId);
  addParticipant(io, s, new Map());
  await s.trigger('call_add_participant', { targetUserId: String(cible), mode });
  return s.emitted.filter((e) => e.event === 'call_add_rejected').map((e) => e.payload.code);
}

/** Rend les codes d'erreur reçus par l'invité — vide s'il est entré. */
async function rejoindre(io, userId) {
  const s = socketDe(userId);
  confJoin(io, s, new Map());
  await s.trigger('call_conf_join', {});
  return s.emitted.filter((e) => e.event === 'call_error').map((e) => e.payload.code);
}

async function reset() {
  for (const uid of TOUS) {
    await callState.clear(uid);
    await pendingCalls.clear(uid);
  }
  callSessions._reset();
  blocages.clear();
  invitationsPoussees.length = 0;
  finsPoussees.length = 0;
}

/**
 * Awa appelle Chris, Chris fait entrer Nadia, puis Chris raccroche. Restent
 * Awa et Nadia, dans la session, chacune avec son appareil actif.
 */
async function retombeeADeux() {
  const io = fakeIo();
  await callState.setInCall(CHRIS, { callId: ORIGIN, peerId: AWA });
  await callState.setInCall(AWA, { callId: ORIGIN, peerId: CHRIS });
  for (const uid of [CHRIS, AWA]) {
    await callDeviceOwnership.setActive(String(ORIGIN), uid, {
      activeDeviceId: appareil(uid), activeSocketId: `sock-${uid}`,
    });
  }
  assert.deepStrictEqual(await ajouter(io, CHRIS, NADIA), [], 'premier ajout');
  const { sessionId } = await callSessions.getByUser(NADIA);
  assert.deepStrictEqual(await rejoindre(io, NADIA), [], 'Nadia entre');
  assert.strictEqual(await leaveCallSession(io, null, CHRIS, 'hangup'), true);
  const s = await callSessions.get(sessionId);
  assert.deepStrictEqual(callSessions.participantIds(s).sort((a, b) => a - b), [AWA, NADIA]);
  return sessionId;
}

(async () => {
  // ── 1. Retombées à deux, Awa transfère à son tour ───────────────────────────
  await reset();
  const sid = await retombeeADeux();
  // L'appel d'origine d'Awa porte un appareil périmé : la greffe ne doit pas
  // le recopier par-dessus celui que la session connaît.
  await callDeviceOwnership.setActive(String(ORIGIN), AWA, {
    activeDeviceId: 'appareil-perime', activeSocketId: 'sock-perime',
  });
  let io = fakeIo();
  assert.deepStrictEqual(await ajouter(io, AWA, SAMUEL, 'transfer'), [], 'greffe acceptée');
  assert.strictEqual(io.pour(AWA, 'call_add_pending')[0]?.sessionId, sid, 'même session');
  assert.strictEqual(io.pour(NADIA, 'call_add_pending')[0]?.sessionId, sid, "l'ancienne invitée est prévenue");
  const invite = io.pour(SAMUEL, 'call_conf_invite')[0];
  assert.strictEqual(invite?.sessionId, sid);
  assert.strictEqual(invite.inviteId, `${sid}_r2`, 'identifiant propre au second tour');
  assert.strictEqual(invite.mode, 'transfer');
  const pousse = invitationsPoussees.at(-1);
  assert.strictEqual(pousse[5], `${sid}_r2`, "le FCM présente l'invitation, pas la session");
  assert.strictEqual(pousse[6].sessionId, sid, 'la session voyage à côté');
  assert.strictEqual(await callState.get(SAMUEL), 'ringing');
  assert.strictEqual(
    await callDeviceOwnership.getActiveDeviceId(sid, AWA), appareil(AWA),
    "l'appareil actif de la session n'est pas écrasé",
  );

  // ── 2. Une invitation en vol : le second appui est refusé ───────────────────
  assert.deepStrictEqual(await ajouter(fakeIo(), NADIA, PAUL), ['ADD_ALREADY_USED']);

  // ── 3. Samuel refuse : la session continue, le droit revient ────────────────
  io = fakeIo();
  await failInvite(io, sid, 'declined');
  assert.strictEqual(io.pour(AWA, 'call_conf_failed')[0]?.keepSession, true, "l'app garde sa session");
  assert.strictEqual(io.pour(NADIA, 'call_conf_failed')[0]?.keepSession, true);
  assert.strictEqual(io.pour(SAMUEL, 'call_ended')[0]?.inviteId, `${sid}_r2`, "la fin vise l'invitation");
  assert.strictEqual(finsPoussees.at(-1)[3], `${sid}_r2`, 'le FCM de fin aussi');
  assert.ok(await callSessions.get(sid), "la session porte toujours l'appel");
  for (const uid of [AWA, NADIA]) {
    assert.strictEqual(
      await callDeviceOwnership.getActiveDeviceId(sid, uid), appareil(uid),
      `relais média de ${uid} intact`,
    );
    assert.strictEqual(await callState.get(uid), 'in_call');
  }
  assert.strictEqual(await callDeviceOwnership.getEntry(sid, SAMUEL), null, 'Samuel oublié');
  assert.strictEqual(await callState.get(SAMUEL), 'idle');

  // ── 4. Chris, parti, est réinvité et revient ────────────────────────────────
  io = fakeIo();
  assert.deepStrictEqual(await ajouter(io, NADIA, CHRIS), [], 'réinvitation acceptée');
  assert.strictEqual(io.pour(CHRIS, 'call_conf_invite')[0]?.inviteId, `${sid}_r3`);
  assert.deepStrictEqual(await rejoindre(io, CHRIS), [], 'Chris peut revenir');
  const aTrois = await callSessions.get(sid);
  assert.strictEqual(aTrois.participants.size, 3);
  assert.strictEqual(aTrois.joins, 2);
  assert.strictEqual(io.pour(AWA, 'call_conf_joined').length, 1, 'Awa ouvre la connexion vers Chris');
  assert.strictEqual(io.pour(NADIA, 'call_conf_joined').length, 1, 'Nadia aussi');

  // ── 5. À trois : plus de place ──────────────────────────────────────────────
  assert.deepStrictEqual(await ajouter(fakeIo(), AWA, PAUL), ['ADD_ALREADY_USED']);

  // ── 6. Le dernier restant est entré au troisième tour : sa fin vise son
  //       invitation, seul identifiant que son CallKit connaisse ─────────────
  await leaveCallSession(fakeIo(), null, AWA, 'hangup');
  finsPoussees.length = 0;
  await leaveCallSession(fakeIo(), null, NADIA, 'hangup');
  const finChris = finsPoussees.find((args) => args[0] === CHRIS);
  assert.ok(finChris, 'le dernier est prévenu');
  assert.strictEqual(finChris[3], `${sid}_r3`, "la fin vise l'invitation de Chris");
  assert.strictEqual(await callSessions.get(sid), null, 'session terminée');

  // ── 7. Un présent raccroche pendant une sonnerie greffée ────────────────────
  await reset();
  const sid2 = await retombeeADeux();
  assert.deepStrictEqual(await ajouter(fakeIo(), AWA, SAMUEL), []);
  io = fakeIo();
  assert.strictEqual(await leaveCallSession(io, null, NADIA, 'hangup'), true);
  assert.strictEqual(io.pour(SAMUEL, 'call_ended')[0]?.inviteId, `${sid2}_r2`, 'sonnerie de Samuel coupée');
  assert.strictEqual(io.pour(AWA, 'call_ended').length, 1, "l'appel d'Awa se termine");
  assert.strictEqual(await callSessions.get(sid2), null, 'session terminée');
  assert.strictEqual(await callSessions.getByUser(SAMUEL), null);
  assert.strictEqual(await callState.get(AWA), 'idle');
  assert.strictEqual(await callDeviceOwnership.getActiveDeviceId(sid2, AWA), null, 'propriété libérée');

  // ── 8. Blocage : refusé avant toute invitation ──────────────────────────────
  await reset();
  const sid3 = await retombeeADeux();
  blocages.add(`${NADIA}:${PAUL}`);
  io = fakeIo();
  assert.deepStrictEqual(await ajouter(io, AWA, PAUL), ['TARGET_BLOCKED']);
  assert.strictEqual(io.pour(NADIA, 'call_add_pending').length, 0, 'Nadia ne voit rien passer');
  assert.strictEqual((await callSessions.get(sid3)).pending, null);
  assert.strictEqual(await callDeviceOwnership.getEntry(sid3, PAUL), null, 'aucune sonnerie posée');
  assert.deepStrictEqual(await ajouter(fakeIo(), AWA, SAMUEL), [], 'le droit reste entier');

  await reset();
  console.log('✅ callSessionRegraft.test.js — tous les cas passent');
  process.exit(0);
})().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
