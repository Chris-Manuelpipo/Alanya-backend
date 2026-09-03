/**
 * `meeting:join_room` — appartenance exigée avant d'entrer dans la salle.
 *
 * Le handler vérifiait l'identité, l'appareil et la présence multi-appareils,
 * mais jamais que le compte figurait dans `participant`. Un compte authentifié
 * qui connaissait un `idMeeting` entrait dans la salle, recevait le roster et
 * les instantanés micro/caméra, et échangeait offres, réponses et candidats ICE
 * avec les présents.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du handler ; faux
 * socket local sur le modèle de `confJoinErrors.test.js`.
 */
const assert = require('assert');

const dbPath = require.resolve('../../config/db');
let calls = [];
let responses = [];
const fakePool = {
  execute: async (sql, params) => {
    calls.push({ sql, params });
    return [responses.shift() ?? [], []];
  },
  end: async () => {},
};
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakePool,
  paths: [],
  children: [],
};

// La présence par appareil parle à Redis ou à un repli mémoire : on la neutralise
// pour n'observer que la décision d'appartenance. `tryJoin` ne doit de toute
// façon jamais être atteint par un intrus — c'est l'objet du second test.
const presencePath = require.resolve('../state/meetingDevicePresence');
let tryJoinAppele = 0;
require.cache[presencePath] = {
  id: presencePath,
  filename: presencePath,
  loaded: true,
  paths: [],
  children: [],
  exports: {
    tryJoin: async () => { tryJoinAppele += 1; return { ok: true }; },
    isOwnerDevice: async () => true,
    getActiveDeviceId: async () => 'dev-1',
    leave: async () => {},
    clearMeeting: async () => {},
    get: async () => null,
  },
};

const { meetingJoinRoom } = require('./meetings');

function fakeSocket(alanyaID) {
  const handlers = {};
  const emitted = [];
  const rooms = [];
  return {
    id: `sock_${alanyaID}`,
    alanyaID,
    authenticated: true,
    deviceId: 'dev-1',
    currentMeetingID: null,
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    join(room) { rooms.push(room); },
    to() { return { emit() {} }; },
    async trigger(event, data) { return handlers[event](data); },
    get emitted() { return emitted; },
    get rooms() { return rooms; },
  };
}

const fakeIo = () => ({ to: () => ({ emit() {} }) });

/** Ligne du LEFT JOIN de `loadMeetingAccess`. */
const ligne = ({ organiser, participant, isEnd = 0, echue = 0 }) => ({
  idMeeting: 7,
  idOrganiser: organiser,
  isEnd,
  echue,
  type_media: 0,
  duree: 60,
  start_time: new Date('2026-09-03T10:00:00Z'),
  room: 'mtg-1756890000000',
  participantStatus: participant ? 1 : null,
  estParticipant: participant ? 1 : 0,
});

async function main() {
  /* ── Un étranger est refusé, et n'a rien touché ── */
  calls = [];
  tryJoinAppele = 0;
  responses = [[ligne({ organiser: 99, participant: false })]];
  let s = fakeSocket(42);
  meetingJoinRoom(fakeIo(), s, new Map());
  await s.trigger('meeting:join_room', { meetingID: 7, userID: 42 });

  assert.strictEqual(s.emitted.length, 1, 'une seule réponse');
  assert.strictEqual(s.emitted[0].event, 'meeting:join_denied');
  assert.strictEqual(s.emitted[0].payload.code, 'NOT_A_PARTICIPANT');
  assert.deepStrictEqual(s.rooms, [], 'l’intrus ne rejoint aucune room');
  assert.strictEqual(s.currentMeetingID, null);
  assert.ok(
    !calls.some((c) => /UPDATE\s+participant/i.test(c.sql)),
    'aucune présence n’est écrite pour un non-participant',
  );
  assert.strictEqual(
    tryJoinAppele,
    0,
    'le contrôle passe AVANT tryJoin : un intrus ne consomme pas le slot d’appareil',
  );

  /* ── Un invité entre normalement ── */
  calls = [];
  tryJoinAppele = 0;
  responses = [
    [ligne({ organiser: 99, participant: true })], // loadMeetingAccess
    [],                                            // UPDATE participant … connecte
    [{ nom: 'Awa', pseudo: 'awa' }],               // SELECT nom, pseudo
  ];
  s = fakeSocket(42);
  meetingJoinRoom(fakeIo(), s, new Map());
  await s.trigger('meeting:join_room', { meetingID: 7, userID: 42 });

  const refus = s.emitted.filter((e) => e.event === 'meeting:join_denied');
  assert.deepStrictEqual(refus, [], 'aucun refus pour un invité');
  assert.ok(
    s.emitted.some((e) => e.event === 'meeting:room_joined'),
    'l’invité reçoit bien room_joined',
  );
  assert.deepStrictEqual(s.rooms, ['meeting_7']);
  assert.strictEqual(tryJoinAppele, 1);

  /* ── L'organisateur sans ligne `participant` entre aussi ── */
  calls = [];
  tryJoinAppele = 0;
  responses = [
    [ligne({ organiser: 42, participant: false })],
    [],
    [{ nom: 'Awa', pseudo: 'awa' }],
  ];
  s = fakeSocket(42);
  meetingJoinRoom(fakeIo(), s, new Map());
  await s.trigger('meeting:join_room', { meetingID: 7, userID: 42 });
  assert.ok(
    s.emitted.some((e) => e.event === 'meeting:room_joined'),
    'l’organisateur n’est jamais enfermé dehors de sa propre réunion',
  );

  /* ── Un membre ne rentre pas dans une réunion soldée ── */
  calls = [];
  responses = [[ligne({ organiser: 99, participant: true, isEnd: 1 })]];
  s = fakeSocket(42);
  meetingJoinRoom(fakeIo(), s, new Map());
  await s.trigger('meeting:join_room', { meetingID: 7, userID: 42 });
  assert.strictEqual(s.emitted[0].event, 'meeting:join_denied');
  assert.strictEqual(s.emitted[0].payload.code, 'MEETING_ENDED');

  /* ── ... ni dans une réunion dont l'échéance est passée ── */
  // Rien ne clôt une réunion à son heure : sans cette garde, une réunion
  // vieille de trois semaines restait rejoignable.
  calls = [];
  responses = [[ligne({ organiser: 99, participant: true, echue: 1 })]];
  s = fakeSocket(42);
  meetingJoinRoom(fakeIo(), s, new Map());
  await s.trigger('meeting:join_room', { meetingID: 7, userID: 42 });
  assert.strictEqual(s.emitted[0].payload.code, 'MEETING_EXPIRED');

  /* ── L'étranger, lui, n'apprend jamais laquelle des trois raisons ── */
  calls = [];
  responses = [[ligne({ organiser: 99, participant: false, isEnd: 1, echue: 1 })]];
  s = fakeSocket(42);
  meetingJoinRoom(fakeIo(), s, new Map());
  await s.trigger('meeting:join_room', { meetingID: 7, userID: 42 });
  assert.strictEqual(
    s.emitted[0].payload.code,
    'NOT_A_PARTICIPANT',
    'l’appartenance est testée en premier : les autres codes en diraient trop',
  );

  console.log('✓ meeting:join_room : appartenance, réunion soldée et échéance');
}

main()
  .then(() => fakePool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
