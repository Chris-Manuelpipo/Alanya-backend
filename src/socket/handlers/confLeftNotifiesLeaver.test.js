// Celui que le serveur retire d'un appel à trois doit l'apprendre.
//
// `call_conf_left` n'était émis que vers les restants, et le partant n'était
// prévenu que pour `media_not_ready`. Retiré par une grâce de déconnexion
// expirée, par une reprise refusée ou par un accusé manqué, il ne recevait
// RIEN : ni socket, ni notification. Son écran d'appel restait ouvert sur une
// conférence dont il ne faisait plus partie, et rien ne pouvait l'en sortir.
//
// Le `call_ended` seul ne suffit pas : pendant une conférence encore peuplée
// l'application l'ignore délibérément, par garde contre les `call_ended`
// parasites, et le partant a justement encore ses liens ouverts. C'est le
// `call_conf_left` portant son propre identifiant qui le lui apprend.
//
// Handlers réels sur le repli mémoire des états ; la base est neutralisée.
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

const blockUtils = require('../../utils/blockUtils');
blockUtils.isBlockedEitherWay = async () => false;

const finsPoussees = [];
const notifications = require('../../services/notificationService');
notifications.notifyIncomingCall = async () => {};
notifications.notifyCallEnded = async (...args) => { finsPoussees.push(args); };

const { addParticipant, confJoin, leaveCallSession } = require('./calls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const pendingCalls = require('../state/pendingCalls');
const { makeFakeIo } = require('../../testUtils/fakeIo');

const CHRIS = 1;
const AWA = 2;
const NADIA = 3;
const TOUS = [CHRIS, AWA, NADIA];
const ORIGIN = 77;
const appareil = (uid) => `appareil-${uid}`;

function fakeIo() {
  const sent = [];
  const base = makeFakeIo([]);
  return {
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
    /** Charges de [event] reçues par [userId], sur son compte ou un appareil. */
    pour(userId, event) {
      return sent
        .filter((e) => e.event === event
          && (e.room === `user_${userId}`
            || e.room.startsWith(`user_${userId}_device_`)))
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

async function ajouter(io, userId, cible) {
  const s = socketDe(userId);
  addParticipant(io, s, new Map());
  await s.trigger('call_add_participant', { targetUserId: String(cible), mode: 'join' });
  return s.emitted.filter((e) => e.event === 'call_add_rejected').map((e) => e.payload.code);
}

async function rejoindre(io, userId) {
  const s = socketDe(userId);
  confJoin(io, s, new Map());
  await s.trigger('call_conf_join', {});
  return s.emitted.filter((e) => e.event === 'call_error').map((e) => e.payload.code);
}

/** Chris, Awa et Nadia dans la même session. Rend l'`io` qui a tout capté. */
async function aTrois() {
  for (const uid of TOUS) {
    await callState.clear(uid);
    await pendingCalls.clear(uid);
  }
  callSessions._reset();
  callDeviceOwnership._reset();

  const io = fakeIo();
  await callState.setInCall(CHRIS, { callId: ORIGIN, peerId: AWA });
  await callState.setInCall(AWA, { callId: ORIGIN, peerId: CHRIS });
  for (const uid of [CHRIS, AWA]) {
    await callDeviceOwnership.setActive(String(ORIGIN), uid, {
      activeDeviceId: appareil(uid), activeSocketId: `sock-${uid}`,
    });
  }
  assert.deepStrictEqual(await ajouter(io, CHRIS, NADIA), [], 'ajout accepté');
  assert.deepStrictEqual(await rejoindre(io, NADIA), [], 'Nadia entre');
  // Remis à zéro APRÈS le montage : entrer dans la session retire déjà
  // l'invitation des autres appareils de Nadia, et cela passe par une
  // notification de fin. Ce test ne parle que de son départ.
  finsPoussees.length = 0;
  return io;
}

(async () => {
  // ── 1. Retrait décidé par le serveur : Nadia l'apprend ─────────────────────
  let io = await aTrois();
  assert.strictEqual(
    await leaveCallSession(io, null, NADIA, 'disconnect_grace_expired'),
    true,
  );

  const sienne = io.pour(NADIA, 'call_conf_left');
  assert.strictEqual(
    sienne.length,
    1,
    'Nadia doit recevoir un call_conf_left : sans lui, son écran reste ouvert '
      + 'sur une conférence dont elle vient d\'être retirée',
  );
  assert.strictEqual(
    String(sienne[0].userId),
    String(NADIA),
    'et il porte SON identifiant — c\'est à cela que son app le reconnaît',
  );
  assert.strictEqual(
    io.pour(NADIA, 'call_ended').length,
    1,
    'plus un call_ended, pour l\'app au premier plan hors conférence peuplée',
  );
  assert.strictEqual(
    finsPoussees.length,
    1,
    'et une notification, pour le cas où son app est en arrière-plan',
  );

  for (const uid of [CHRIS, AWA]) {
    assert.strictEqual(
      io.pour(uid, 'call_conf_left').length,
      1,
      `les restants restent prévenus comme avant (user=${uid})`,
    );
  }

  // ── 2. Départ voulu : Nadia a raccroché, son app sait déjà ─────────────────
  io = await aTrois();
  assert.strictEqual(await leaveCallSession(io, null, NADIA, 'hangup'), true);

  assert.strictEqual(
    io.pour(NADIA, 'call_conf_left').length,
    0,
    'elle a appuyé sur Raccrocher : le lui annoncer serait au mieux redondant',
  );
  assert.strictEqual(
    io.pour(NADIA, 'call_ended').length,
    0,
    'et un call_ended en retard raccrocherait son appel suivant',
  );
  for (const uid of [CHRIS, AWA]) {
    assert.strictEqual(
      io.pour(uid, 'call_conf_left').length,
      1,
      `le départ reste annoncé aux restants (user=${uid})`,
    );
  }

  console.log('✅ confLeftNotifiesLeaver : 2 cas');
  process.exit(0);
})().catch((e) => {
  console.error('❌ confLeftNotifiesLeaver:', e);
  process.exit(1);
});
