/**
 * Bascule au répondeur au bout du délai sans réponse.
 *
 * C'est le chemin qui INVERSE le principe de la v1 : le téléphone sonne
 * d'abord, et l'appel bascule ensuite. Deux choses doivent tenir, et une seule
 * se voit dans le code appelant.
 *
 * 1. Le DÉLAI est choisi à l'armement, parce que c'est le seul paramètre qui
 *    traverse `job_queue` côté Redis.
 * 2. La DÉCISION est reprise à l'échéance, dans `onNoAnswer`, parce que le
 *    rappel de fonction, lui, est jeté en route.
 *
 * Si quelqu'un inverse un jour ces deux-là — en essayant par exemple de
 * transporter la variante dans le minuteur — le comportement redeviendra
 * « sans réponse » sur une instance à Redis, et personne ne le verra en
 * développement où le repli mémoire garde le rappel.
 */
const assert = require('assert');

const CALLER = 811;
const TARGET = 812;

const inserts = [];
const updates = [];
const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO callHistory/.test(texte)) {
      inserts.push({ params });
      return [{ insertId: 7373 }, []];
    }
    if (/^UPDATE callHistory SET status/.test(texte)) {
      updates.push({ params });
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM callHistory/.test(texte)) return [[], []];
    return [[{ conversID: 55 }], []];
  },
  getConnection: async () => ({
    beginTransaction: async () => {},
    execute: async () => [{ insertId: 55 }, []],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  }),
};

const notifs = [];
const fakeNotifications = {
  notifyIncomingCall: async (...args) => { notifs.push({ fn: 'notifyIncomingCall', args }); },
  notifyGroupCall: async () => {},
  notifyCallEnded: async (...args) => { notifs.push({ fn: 'notifyCallEnded', args }); },
  notifyVoicemailActive: async () => {},
};

let filetArme = false;
const fakeVoicemail = {
  shouldInterceptCall: async () => ({ intercept: false, schedule: { no_answer_enabled: filetArme ? 1 : 0 } }),
  shouldFallBackToVoicemail: async () => ({
    fallback: filetArme,
    schedule: { resolvedTimezone: 'Africa/Douala' },
  }),
  noAnswerDelayMs: (schedule, defaut) => (schedule?.no_answer_enabled ? 27000 : defaut),
};

const stub = (chemin, exports) => {
  const p = require.resolve(chemin);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, paths: [], children: [] };
};

stub('../../config/db', fakePool);
stub('../../services/notificationService', fakeNotifications);
stub('../../services/voicemailScheduleService', fakeVoicemail);
stub('../../utils/blockUtils', { isBlockedEitherWay: async () => false });
stub('../../utils/officialAccountGuard', { isOfficialAccount: async () => false });

const callState = require('../state/callState');
const pendingCalls = require('../state/pendingCalls');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callUser, onNoAnswer } = require('./calls');

function fakeSocket(userId) {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: 'dev',
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    async trigger(event, data) { await handlers[event](data); },
    get emitted() { return emitted; },
  };
}

function fakeIo() {
  const rooms = [];
  return {
    rooms,
    sockets: { adapter: { rooms: new Map() } },
    to(room) { return { emit(event, payload) { rooms.push({ room, event, payload }); } }; },
    in(room) {
      const connecte = [CALLER, TARGET].some((id) => room === `user_${id}`);
      return { fetchSockets: async () => (connecte ? [{ id: room, data: {} }] : []) };
    },
  };
}

/** Mémorise le délai passé à `scheduleNoAnswer`, sans exécuter le minuteur. */
let delaiArme = null;
const vraiSchedule = callState.scheduleNoAnswer;
callState.scheduleNoAnswer = async (userId, onExpire, ms) => {
  delaiArme = ms;
  // On n'arme rien : le test déclenche `onNoAnswer` lui-même, comme le ferait
  // le worker Redis.
};

async function repartirDeZero() {
  await callState.clear(CALLER);
  await callState.clear(TARGET);
  await pendingCalls.clear(TARGET);
  await callDeviceOwnership.release('4242');
  inserts.length = 0;
  updates.length = 0;
  notifs.length = 0;
  delaiArme = null;
}

async function appeler(io, socket) {
  callUser(io, socket, new Map());
  await socket.trigger('call_user', {
    targetUserId: TARGET,
    callerName: 'Chris',
    isVideo: false,
    offer: { type: 'offer', sdp: 'v=0' },
  });
}

async function main() {
  /* ══ Le délai est choisi à l'armement ══ */

  await repartirDeZero();
  filetArme = false;
  let io = fakeIo();
  await appeler(io, fakeSocket(CALLER));
  assert.strictEqual(delaiArme, 45 * 1000, 'sans filet armé, le délai d’origine ne bouge pas');

  const pushSansFilet = notifs.find((n) => n.fn === 'notifyIncomingCall');
  assert.ok(pushSansFilet, 'le push d’appel part normalement');
  assert.strictEqual(pushSansFilet.args[7]?.ttlMs, 45 * 1000);

  await repartirDeZero();
  filetArme = true;
  io = fakeIo();
  await appeler(io, fakeSocket(CALLER));
  assert.strictEqual(delaiArme, 27 * 1000, 'filet armé ⇒ bascule à 27 s');

  // La validité du push suit le délai, sinon un push délivré à 40 s ferait
  // sonner un téléphone dont l'appel est parti au répondeur treize secondes
  // plus tôt.
  const pushAvecFilet = notifs.find((n) => n.fn === 'notifyIncomingCall');
  assert.strictEqual(
    pushAvecFilet.args[7]?.ttlMs,
    27 * 1000,
    'la validité du push d’appel suit le délai de bascule',
  );

  /* ══ La décision est reprise à l'échéance ══ */

  // Le destinataire sonne encore : c'est l'état que `onNoAnswer` revalide.
  await repartirDeZero();
  filetArme = true;
  await callState.setRinging(TARGET, { callId: 4242, peerId: CALLER, isVideo: false });
  await callState.setRinging(CALLER, { callId: 4242, peerId: TARGET, isVideo: false });

  io = fakeIo();
  await onNoAnswer(io, new Map(), 4242, CALLER, TARGET);

  const vm = io.rooms.find((r) => r.event === 'call_voicemail');
  assert.ok(vm, 'l’appelant est invité à laisser un message');
  assert.strictEqual(vm.room, `user_${CALLER}`, 'et c’est bien lui qui le reçoit');
  assert.strictEqual(vm.payload.didRing, true, 'le téléphone A sonné : la feuille le dira');
  assert.strictEqual(
    io.rooms.some((r) => r.event === 'call_no_answer'),
    false,
    'et surtout pas « pas de réponse » : l’appel n’est pas perdu',
  );
  assert.deepStrictEqual(
    updates[0].params,
    [5, 4242],
    'statut 5 — a sonné, puis répondeur ; il COMPTE dans le taux de réussite',
  );
  assert.strictEqual(inserts.length, 0, 'la ligne existait déjà : on la met à jour');

  // La sonnerie du destinataire est coupée dans les deux cas — c'est ce qui
  // évite qu'un téléphone continue de sonner après la bascule.
  assert.ok(
    io.rooms.find((r) => r.event === 'call_ended' && r.room === `user_${TARGET}`),
    'le destinataire cesse de sonner, app au premier plan',
  );
  assert.ok(
    notifs.find((n) => n.fn === 'notifyCallEnded'),
    'et app tuée : c’est le seul chemin qui éteint CallKit',
  );

  /* ══ Sans filet, rien ne change ══ */

  await repartirDeZero();
  filetArme = false;
  await callState.setRinging(TARGET, { callId: 4243, peerId: CALLER, isVideo: false });
  await callState.setRinging(CALLER, { callId: 4243, peerId: TARGET, isVideo: false });

  io = fakeIo();
  await onNoAnswer(io, new Map(), 4243, CALLER, TARGET);

  assert.ok(
    io.rooms.find((r) => r.event === 'call_no_answer'),
    'comportement d’origine préservé',
  );
  assert.strictEqual(io.rooms.some((r) => r.event === 'call_voicemail'), false);
  assert.deepStrictEqual(updates[0].params, [3, 4243], 'statut 3 — sans réponse');

  /* ══ L'échéance périmée ne fait rien ══ */

  // Garde d'idempotence : le job Redis peut arriver après un décrochage ou un
  // refus. Sans elle, il raccrocherait l'appel suivant.
  await repartirDeZero();
  filetArme = true;
  io = fakeIo();
  await onNoAnswer(io, new Map(), 9999, CALLER, TARGET);
  assert.strictEqual(io.rooms.length, 0, 'aucun état ringing ⇒ aucune émission');
  assert.strictEqual(updates.length, 0);

  callState.scheduleNoAnswer = vraiSchedule;
  await repartirDeZero();
  console.log('✓ voicemailNoAnswer : délai armé, décision à l’échéance, statut 5, sonnerie coupée');
}

main().catch((e) => {
  console.error('voicemailNoAnswer.test.js ÉCHEC :', e);
  process.exit(1);
});
