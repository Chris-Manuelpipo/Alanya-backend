/**
 * Les deux déclencheurs qui restaient : le refus explicite et la ligne occupée.
 *
 * Ils partagent l'interrupteur des 27 secondes, mais pas le statut, et c'est le
 * point à ne pas confondre :
 *
 *   refus   → statut 5, le téléphone A sonné, la personne a vu l'appel ;
 *   occupé  → statut 4, le téléphone N'A PAS sonné, il était déjà pris.
 *
 * Le second ne doit donc pas alourdir le taux de réussite des appels, le
 * premier si.
 *
 * Le test qui compte le plus est négatif : un refus d'invitation de CONFÉRENCE
 * ne doit jamais partir au répondeur. On est en pleine communication à trois,
 * il n'y a aucun appelant disponible pour laisser un message — et la branche
 * conférence sort avant tout le reste dans `processRejectCall`.
 */
const assert = require('assert');

const CALLER = 821;
const TARGET = 822;

const inserts = [];
const updates = [];
const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO callHistory/.test(texte)) {
      inserts.push({ params });
      return [{ insertId: 8484 }, []];
    }
    if (/^UPDATE callHistory SET status/.test(texte)) {
      updates.push({ params });
      return [{ affectedRows: 1 }, []];
    }
    if (/SELECT IDcall FROM callHistory/.test(texte)) return [[{ IDcall: 8484 }], []];
    if (/FROM callHistory/.test(texte)) return [[], []];
    return [[{ conversID: 66 }], []];
  },
  getConnection: async () => ({
    beginTransaction: async () => {},
    execute: async () => [{ insertId: 66 }, []],
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
  shouldInterceptCall: async () => ({
    intercept: false,
    schedule: { no_answer_enabled: filetArme ? 1 : 0, resolvedTimezone: 'Africa/Douala' },
  }),
  shouldFallBackToVoicemail: async () => ({
    fallback: filetArme,
    schedule: { resolvedTimezone: 'Africa/Douala' },
  }),
  noAnswerDelayMs: (schedule, defaut) => defaut,
  isNoAnswerEnabled: (schedule) => !!schedule?.no_answer_enabled,
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
const callSessions = require('../state/callSessions');
const pendingCalls = require('../state/pendingCalls');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callUser, processRejectCall } = require('./calls');

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
      // `emitToUserExceptDevice` parcourt les sockets et appelle `emit` sur
      // chacune : la doublure doit en avoir une.
      return {
        fetchSockets: async () => (connecte
          ? [{
              id: room,
              data: {},
              deviceId: 'autre_appareil',
              emit(event, payload) { rooms.push({ room, event, payload }); },
            }]
          : []),
      };
    },
  };
}

async function repartirDeZero() {
  await callState.clear(CALLER);
  await callState.clear(TARGET);
  await callState.clear(999);
  await pendingCalls.clear(TARGET);
  await callDeviceOwnership.release('8484');
  if (callSessions._reset) callSessions._reset();
  inserts.length = 0;
  updates.length = 0;
  notifs.length = 0;
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
  /* ══ Ligne occupée, filet armé : répondeur ══ */

  await repartirDeZero();
  filetArme = true;
  // Le destinataire est en communication avec quelqu'un d'autre.
  await callState.setInCall(TARGET, { callId: 777, peerId: 999 });

  let io = fakeIo();
  let sock = fakeSocket(CALLER);
  await appeler(io, sock);

  const vm = sock.emitted.find((e) => e.event === 'call_voicemail');
  assert.ok(vm, 'l’appelant peut laisser un message au lieu d’entendre « occupé »');
  assert.strictEqual(
    vm.payload.didRing,
    false,
    'le téléphone n’a pas sonné : la feuille dira « indisponible », pas « n’a pas répondu »',
  );
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_busy'),
    false,
    'et surtout pas « occupé »',
  );
  assert.deepStrictEqual(
    inserts[0].params.slice(0, 4),
    [CALLER, TARGET, 0, 4],
    'statut 4 : la ligne était prise, il n’y avait rien à rater',
  );

  /* ══ Ligne occupée, filet éteint : « occupé » comme avant ══ */

  await repartirDeZero();
  filetArme = false;
  await callState.setInCall(TARGET, { callId: 777, peerId: 999 });

  io = fakeIo();
  sock = fakeSocket(CALLER);
  await appeler(io, sock);

  assert.ok(sock.emitted.find((e) => e.event === 'call_busy'), 'comportement d’origine préservé');
  assert.strictEqual(sock.emitted.some((e) => e.event === 'call_voicemail'), false);
  assert.strictEqual(inserts.length, 0, 'aucune ligne de journal pour un appel jamais parti');

  /* ══ Refus explicite, filet armé : répondeur, statut 5 ══ */

  await repartirDeZero();
  filetArme = true;
  await callState.setRinging(TARGET, { callId: 8484, peerId: CALLER, isVideo: false });
  await callState.setRinging(CALLER, { callId: 8484, peerId: TARGET, isVideo: false });

  io = fakeIo();
  let res = await processRejectCall({
    io, userSockets: new Map(), callerID: CALLER, receiverID: TARGET,
    callIdHint: '8484', rejectingDeviceId: 'dev',
  });

  assert.strictEqual(res.voicemail, true);
  const vmRefus = io.rooms.find((r) => r.event === 'call_voicemail');
  assert.ok(vmRefus, 'refuser mène au répondeur');
  assert.strictEqual(vmRefus.room, `user_${CALLER}`);
  assert.strictEqual(vmRefus.payload.didRing, true, 'le téléphone a sonné, la personne a écarté l’appel');
  assert.strictEqual(
    io.rooms.some((r) => r.event === 'call_rejected'),
    false,
    'l’appelant n’est pas éconduit : on lui propose de laisser un message',
  );
  assert.ok(
    updates.some((u) => u.params[0] === 5),
    'statut 5 : a sonné puis répondeur — il compte dans le taux de réussite',
  );

  /* ══ Refus explicite, filet éteint : refus sec ══ */

  await repartirDeZero();
  filetArme = false;
  await callState.setRinging(TARGET, { callId: 8484, peerId: CALLER, isVideo: false });
  await callState.setRinging(CALLER, { callId: 8484, peerId: TARGET, isVideo: false });

  io = fakeIo();
  await processRejectCall({
    io, userSockets: new Map(), callerID: CALLER, receiverID: TARGET,
    callIdHint: '8484', rejectingDeviceId: 'dev',
  });

  assert.ok(io.rooms.find((r) => r.event === 'call_rejected'), 'comportement d’origine préservé');
  assert.strictEqual(io.rooms.some((r) => r.event === 'call_voicemail'), false);
  assert.ok(updates.some((u) => u.params[0] === 2), 'statut 2 — refusé');

  /* ══ LA GARDE QUI COMPTE : un refus de conférence ne bascule JAMAIS ══ */

  await repartirDeZero();
  filetArme = true;
  // Le destinataire a une invitation de conférence en attente : la branche
  // conférence de `processRejectCall` sort AVANT tout le reste.
  await callSessions.openWithPending({
    participants: [CALLER, 999], inviteeId: TARGET, byUserId: CALLER,
  });

  io = fakeIo();
  res = await processRejectCall({
    io, userSockets: new Map(), callerID: CALLER, receiverID: TARGET,
    rejectingDeviceId: 'dev',
  });

  assert.strictEqual(res.conference, true, 'la branche conférence a bien été prise');
  assert.strictEqual(
    io.rooms.some((r) => r.event === 'call_voicemail'),
    false,
    'aucun répondeur en pleine communication à trois : il n’y a pas d’appelant disponible pour laisser un message',
  );
  assert.strictEqual(updates.length, 0, 'et aucun statut d’appel à deux réécrit');

  await repartirDeZero();
  console.log('✓ voicemailRejectBusy : refus en 5, occupé en 4, conférence intacte');
}

main().catch((e) => {
  console.error('voicemailRejectBusy.test.js ÉCHEC :', e);
  process.exit(1);
});
