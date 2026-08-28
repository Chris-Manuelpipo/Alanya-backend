// L'arrivant dans un appel de groupe reçoit la liste de ceux qui y sont déjà.
//
// `join_group_call` finissait sur `Array.from(participants.keys())`, un
// identifiant déclaré nulle part. La ReferenceError partait dans le `catch` du
// handler, qui n'en journalisait que le message : tout ce qui précédait avait
// réussi — la salle rejointe, les autres prévenus par `group_user_joined` — mais
// `group_participants` ne sortait jamais.
//
// Côté client, le roster de l'arrivant se limitait alors à lui-même et à celui
// qui l'avait invité. Or `group:mute_state` et `group:video_state` ne sont
// appliqués que pour un identifiant déjà au roster, et la grille filtre les
// flux par le roster : l'arrivant ne voyait donc ni les tuiles des autres, ni
// leurs micros se couper.
const assert = require('assert');
const pool = require('../../config/db');
const groupRooms = require('../state/groupRooms');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { createGroupCall, joinGroupCall } = require('./calls');

const ROOM = 'room_roster';
const A = 2201; // crée l'appel
const B = 2202; // rejoint ensuite
const C = 2203; // rejoint en dernier

function fakeSocket(userId) {
  const handlers = {};
  const recu = [];
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: `dev_${userId}`,
    emit(event, payload) { recu.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    to() { return { emit() {} }; },
    join() {}, leave() {},
    get recu() { return recu; },
    async trigger(event, data) { await handlers[event](data); },
  };
}

const fakeIo = () => ({
  sockets: { adapter: { rooms: new Map(), sockets: new Map() } },
  to() { return { emit() {} }; },
  in() { return { socketsLeave() {}, fetchSockets: async () => [] }; },
  socketsLeave() {},
});

function listeRecue(sock) {
  const ev = sock.recu.find((e) => e.event === 'group_participants');
  return ev ? ev.payload.participants : null;
}

async function main() {
  const io = fakeIo();
  const userSockets = new Map();

  if (groupRooms._reset) groupRooms._reset();
  await callDeviceOwnership.release(ROOM);

  // ── A crée l'appel ───────────────────────────────────────────────────────
  const sockA = fakeSocket(A);
  createGroupCall(io, sockA, userSockets);
  await sockA.trigger('create_group_call', {
    roomId: ROOM, isVideo: false, callerName: 'A', targetUserIds: [B, C],
  });

  // ── B rejoint : il doit apprendre que A est là ───────────────────────────
  const sockB = fakeSocket(B);
  joinGroupCall(io, sockB, userSockets);
  await sockB.trigger('join_group_call', { roomId: ROOM, userName: 'B' });

  const vuParB = listeRecue(sockB);
  assert.ok(
    vuParB,
    'group_participants n\'est jamais parti — le handler levait avant de l\'émettre',
  );
  assert.ok(
    vuParB.includes(String(A)),
    'l\'arrivant doit voir celui qui était déjà là, sinon ni sa tuile ni son micro',
  );

  // ── C rejoint : il doit voir A et B ──────────────────────────────────────
  const sockC = fakeSocket(C);
  joinGroupCall(io, sockC, userSockets);
  await sockC.trigger('join_group_call', { roomId: ROOM, userName: 'C' });

  const vuParC = listeRecue(sockC);
  assert.ok(vuParC, 'group_participants attendu pour le second arrivant aussi');
  assert.deepStrictEqual(
    [...vuParC].sort(),
    [String(A), String(B), String(C)].sort(),
    'la liste porte toute la salle, arrivant compris',
  );

  // ── Les identifiants sont des chaînes ────────────────────────────────────
  // Le client fait `_groupRoster.containsKey(userId)` avec la chaîne reçue de
  // `group:mute_state` ; une liste de nombres remplirait le roster de clés qui
  // ne correspondraient à rien.
  assert.ok(
    vuParC.every((id) => typeof id === 'string'),
    'les identifiants doivent être des chaînes, comme ceux de group:mute_state',
  );

  if (groupRooms._reset) groupRooms._reset();
  await callDeviceOwnership.release(ROOM);
  console.log('groupRosterOnJoin.test.js OK');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
