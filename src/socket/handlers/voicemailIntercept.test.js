/**
 * Interception d'un appel par le répondeur : la promesse du produit, vérifiée
 * ligne à ligne.
 *
 * Cette promesse tient en une phrase : quand le répondeur est actif, le
 * téléphone du destinataire NE SONNE PAS. Pas « sonne moins fort », pas
 * « sonne puis raccroche ». Elle se joue entièrement sur ce qui N'EST PAS
 * fait dans `call_user` — et c'est bien plus fragile qu'une assertion
 * positive : il suffit qu'une refonte future rétablisse `notifyIncomingCall`
 * au-dessus de la garde pour que la fonctionnalité redevienne muette sans que
 * rien d'autre ne casse. D'où les assertions négatives ci-dessous.
 *
 * Faux pool, fausses notifications et faux service de créneau injectés dans
 * `require.cache` avant le chargement du handler — même procédé que
 * `src/services/securitySettingsService.test.js`. Aucune base, aucun Firebase.
 */
const assert = require('assert');

const CALLER = 801;
const TARGET = 802;

// ── Doublures ───────────────────────────────────────────────────────────────

const inserts = [];
const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO callHistory/.test(texte)) {
      inserts.push({ sql: texte, params });
      return [{ insertId: 4242 }, []];
    }
    if (/FROM callHistory/.test(texte)) return [[], []]; // finalizeCallAndNotify
    if (/^INSERT INTO conversation/.test(texte)) return [{ insertId: 77 }, []];
    return [[{ conversID: 77 }], []]; // lookup conversation directe
  },
  getConnection: async () => ({
    beginTransaction: async () => {},
    execute: async () => [{ insertId: 77 }, []],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  }),
};

const notifs = [];
const fakeNotifications = {
  notifyIncomingCall: async (...args) => { notifs.push({ fn: 'notifyIncomingCall', args }); },
  notifyGroupCall: async () => {},
  notifyCallEnded: async () => {},
  notifyVoicemailActive: async (...args) => { notifs.push({ fn: 'notifyVoicemailActive', args }); },
};

/** Piloté test par test. */
let verdict = { intercept: false };
let verdictAppels = 0;
let verdictJette = false;
const fakeVoicemail = {
  shouldInterceptCall: async () => {
    verdictAppels += 1;
    if (verdictJette) throw new Error('planification illisible');
    return verdict;
  },
};

let bloque = false;
const stub = (chemin, exports) => {
  const p = require.resolve(chemin);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, paths: [], children: [] };
};

stub('../../config/db', fakePool);
stub('../../services/notificationService', fakeNotifications);
stub('../../services/voicemailScheduleService', fakeVoicemail);
stub('../../utils/blockUtils', { isBlockedEitherWay: async () => bloque });
stub('../../utils/officialAccountGuard', { isOfficialAccount: async () => false });

const callState = require('../state/callState');
const pendingCalls = require('../state/pendingCalls');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callUser } = require('./calls');

// ── Faux socket / io ────────────────────────────────────────────────────────

function fakeSocket(userId, deviceId = 'dev_caller') {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId,
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    async trigger(event, data) { await handlers[event](data); },
    get emitted() { return emitted; },
  };
}

/**
 * `enLigne` : qui `isUserOnline` doit déclarer connecté. Ça compte — sans ça,
 * `reclaimStaleBusy` considère l'appelant hors ligne et purge l'état « occupé »
 * que le test vient de poser, ce qui escamoterait la garde CALLER_BUSY.
 */
function fakeIo(enLigne = [CALLER, TARGET]) {
  const rooms = [];
  return {
    rooms,
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return { emit(event, payload) { rooms.push({ room, event, payload }); } };
    },
    in(room) {
      const connecte = enLigne.some((id) => room === `user_${id}`);
      return { fetchSockets: async () => (connecte ? [{ id: room, data: {} }] : []) };
    },
  };
}

const OFFRE = { type: 'offer', sdp: 'v=0' };

async function appeler(io, socket, extra = {}) {
  callUser(io, socket, new Map());
  await socket.trigger('call_user', {
    targetUserId: TARGET,
    callerName: 'Chris',
    isVideo: false,
    offer: OFFRE,
    ...extra,
  });
}

async function repartirDeZero() {
  await callState.clear(CALLER);
  await callState.clear(TARGET);
  await pendingCalls.clear(TARGET);
  await callDeviceOwnership.release('4242');
  inserts.length = 0;
  notifs.length = 0;
  verdictAppels = 0;
  bloque = false;
  verdictJette = false;
}

async function main() {
  /* ══ Répondeur actif : rien ne sonne ══ */

  await repartirDeZero();
  verdict = {
    intercept: true,
    activeUntil: new Date('2026-09-21T17:00:00Z'),
    schedule: { resolvedTimezone: 'Africa/Douala' },
  };

  let io = fakeIo();
  let sock = fakeSocket(CALLER);
  await appeler(io, sock);

  const vm = sock.emitted.find((e) => e.event === 'call_voicemail');
  assert.ok(vm, 'l’appelant doit être invité à laisser un message');
  assert.strictEqual(vm.payload.callId, '4242');
  assert.strictEqual(vm.payload.targetId, String(TARGET));
  assert.strictEqual(vm.payload.reason, 'voicemail');
  assert.strictEqual(
    vm.payload.conversationID, 77,
    'la conversation est résolue serveur : un aller-retour de moins avant le micro',
  );

  // ── Les assertions qui portent la promesse ──
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_ringing'), false,
    'aucune sonnerie de retour : il n’y a personne à faire sonner',
  );
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_busy'), false,
    'le destinataire n’est pas occupé, il est injoignable par choix',
  );
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_failed'), false,
    'ce n’est pas un échec d’appel',
  );
  assert.strictEqual(
    io.rooms.some((r) => r.event === 'incoming_call'), false,
    'AUCUN incoming_call : un destinataire au premier plan ne doit rien voir',
  );
  assert.strictEqual(
    notifs.some((n) => n.fn === 'notifyIncomingCall'), false,
    'AUCUN push d’appel : c’est lui qui ouvrirait CallKit, app tuée',
  );

  // L'état serveur reste vierge : rien à nettoyer, rien qui expire.
  assert.strictEqual(await callState.get(TARGET), 'idle', 'la cible n’est jamais marquée « ringing »');
  assert.strictEqual(await callState.get(CALLER), 'idle', 'l’appelant non plus');
  assert.strictEqual(await pendingCalls.get(TARGET), null, 'aucun appel bufferisé à rejouer');

  // ── Le journal, et le rappel ──
  assert.strictEqual(inserts.length, 1, 'une seule écriture d’historique');
  assert.ok(
    /VALUES \(\?, \?, \?, 4, NOW\(\), \?\)/.test(inserts[0].sql),
    'statut 4 écrit directement, jamais 0 puis UPDATE',
  );
  assert.deepStrictEqual(inserts[0].params.slice(0, 3), [CALLER, TARGET, 0]);

  const rappel = notifs.find((n) => n.fn === 'notifyVoicemailActive');
  assert.ok(rappel, 'le propriétaire du répondeur est rappelé à l’ordre');
  assert.strictEqual(rappel.args[0], TARGET);
  assert.strictEqual(rappel.args[2].timeZone, 'Africa/Douala');
  assert.strictEqual(rappel.args[2].activeUntil.toISOString(), '2026-09-21T17:00:00.000Z');

  /* ══ Appelant dans la liste autorisée : l’appel sonne normalement ══ */

  await repartirDeZero();
  verdict = { intercept: false, bypassed: true };

  io = fakeIo();
  sock = fakeSocket(CALLER);
  await appeler(io, sock);

  assert.ok(
    sock.emitted.find((e) => e.event === 'call_ringing'),
    'un contact autorisé fait sonner comme avant',
  );
  assert.ok(
    notifs.find((n) => n.fn === 'notifyIncomingCall'),
    'et le push d’appel repart',
  );
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_voicemail'), false,
  );

  /* ══ L’appelant déjà en communication : CALLER_BUSY passe avant ══ */

  // C'est la raison du placement de la garde. Court-circuiter plus haut
  // laisserait quelqu'un déjà en ligne ouvrir une seconde branche sortante.
  await repartirDeZero();
  verdict = { intercept: true, activeUntil: null, schedule: {} };
  await callState.setRinging(CALLER, { callId: 999, peerId: 555, isVideo: false });

  io = fakeIo();
  sock = fakeSocket(CALLER);
  await appeler(io, sock);

  assert.strictEqual(
    sock.emitted[0]?.payload?.code, 'CALLER_BUSY',
    'l’appelant occupé est refusé avant même qu’on regarde le répondeur',
  );
  assert.strictEqual(verdictAppels, 0, 'et le créneau n’est même pas consulté');
  assert.strictEqual(inserts.length, 0, 'aucune ligne de journal pour un appel jamais parti');

  /* ══ Appelant bloqué : le blocage passe avant le répondeur ══ */

  await repartirDeZero();
  verdict = { intercept: true, activeUntil: null, schedule: {} };
  bloque = true;

  io = fakeIo();
  sock = fakeSocket(CALLER);
  await appeler(io, sock);

  assert.strictEqual(
    sock.emitted[0]?.payload?.code, 'CALL_BLOCKED',
    'un bloqué reçoit CALL_BLOCKED, pas une invitation à laisser un message',
  );
  assert.strictEqual(verdictAppels, 0, 'le créneau n’est pas consulté non plus');

  /* ══ Planification illisible : le téléphone sonne ══ */

  // Le défaut penche toujours du même côté. Une erreur d'évaluation ne doit
  // jamais couper un appel — c'est la règle déjà appliquée par
  // `loadUserVoicemailSchedule` quand la table est absente.
  await repartirDeZero();
  verdictJette = true;

  io = fakeIo();
  sock = fakeSocket(CALLER);
  await appeler(io, sock);

  assert.ok(
    sock.emitted.find((e) => e.event === 'call_ringing'),
    'une évaluation impossible laisse passer l’appel',
  );
  assert.strictEqual(sock.emitted.some((e) => e.event === 'call_voicemail'), false);

  await repartirDeZero();
  console.log('✓ voicemailIntercept : rien ne sonne, rien n’est armé, et les gardes gardent leur ordre');
}

main().catch((e) => {
  console.error('voicemailIntercept.test.js ÉCHEC :', e);
  process.exit(1);
});
