// Le scénario signalé : quelqu'un rejoint un appel, coupe son micro — les
// autres le voient-ils, et voit-il les leurs ?
//
// Les rooms sont modélisées pour de vrai : `socket.to(room)` livre à tous les
// membres sauf l'émetteur, `io.to(room)` à tous. Sans cela le test ne dirait
// rien de ce qui circule réellement, qui est précisément la question.
const assert = require('assert');
const pool = require('../../config/db');
const groupRooms = require('../state/groupRooms');
const ownership = require('../state/callDeviceOwnership');
const {
  createGroupCall, joinGroupCall, groupMuteState, groupVideoState,
} = require('./calls');

const ROOM = 'room_mute_join';
const A = 5001; // crée l'appel
const B = 5002; // y est déjà
const C = 5003; // arrive en cours de route

const ROOMS = new Map();
const RECU = new Map();

function makeSocket(userId) {
  const handlers = {};
  const sock = {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: `dev_${userId}`,
    currentGroupRoom: null,
    emit(event, payload) { RECU.get(sock.id).push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    join(room) {
      if (!ROOMS.has(room)) ROOMS.set(room, new Set());
      ROOMS.get(room).add(sock);
    },
    leave(room) { ROOMS.get(room)?.delete(sock); },
    to(room) {
      return {
        emit(event, payload) {
          for (const s of ROOMS.get(room) ?? []) {
            if (s !== sock) RECU.get(s.id).push({ event, payload });
          }
        },
      };
    },
    async trigger(event, data) {
      assert.ok(handlers[event], `aucun handler pour ${event}`);
      await handlers[event](data);
    },
  };
  RECU.set(sock.id, []);
  return sock;
}

const io = {
  sockets: { adapter: { rooms: ROOMS, sockets: new Map() } },
  to(room) {
    return {
      emit(event, payload) {
        for (const s of ROOMS.get(room) ?? []) RECU.get(s.id).push({ event, payload });
      },
    };
  },
  in() { return { socketsLeave() {}, fetchSockets: async () => [] }; },
  socketsLeave() {},
};

const recus = (sock, event) => RECU.get(sock.id).filter((e) => e.event === event);

async function main() {
  if (groupRooms._reset) groupRooms._reset();
  await ownership.release(ROOM);

  const userSockets = new Map();
  const sockA = makeSocket(A);
  const sockB = makeSocket(B);
  const sockC = makeSocket(C);

  for (const s of [sockA, sockB, sockC]) {
    createGroupCall(io, s, userSockets);
    joinGroupCall(io, s, userSockets);
    groupMuteState(io, s, userSockets);
    groupVideoState(io, s, userSockets);
  }

  // ── A crée, B rejoint : l'appel tourne à deux ────────────────────────────
  await sockA.trigger('create_group_call', {
    roomId: ROOM, isVideo: false, callerName: 'A', targetUserIds: [B, C],
  });
  await sockB.trigger('join_group_call', { roomId: ROOM, userName: 'B' });

  // ── C arrive ─────────────────────────────────────────────────────────────
  await sockC.trigger('join_group_call', { roomId: ROOM, userName: 'C' });

  const listeDeC = recus(sockC, 'group_participants').map((e) => e.payload.participants);
  assert.strictEqual(
    listeDeC.length, 1,
    'l\'arrivant doit recevoir group_participants — sans lui son roster est vide, '
    + 'et le client jette les états micro d\'un identifiant qu\'il ne connaît pas',
  );
  assert.deepStrictEqual(
    [...listeDeC[0]].sort(),
    [String(A), String(B), String(C)].sort(),
    'la liste porte ceux qui étaient déjà là',
  );

  // ── C coupe son micro : A et B doivent le voir ───────────────────────────
  await sockC.trigger('group:mute_state', { roomId: ROOM, isMuted: true });

  for (const [nom, sock] of [['A', sockA], ['B', sockB]]) {
    const vus = recus(sock, 'group:mute_state');
    assert.strictEqual(
      vus.length, 1,
      `${nom} doit voir l'arrivant couper son micro`,
    );
    assert.strictEqual(vus[0].payload.userId, String(C), 'et savoir de qui il s\'agit');
    assert.strictEqual(vus[0].payload.isMuted, true);
  }
  assert.strictEqual(
    recus(sockC, 'group:mute_state').length, 0,
    'l\'émetteur ne se reçoit pas lui-même',
  );

  // ── A coupe le sien : C doit le voir ─────────────────────────────────────
  await sockA.trigger('group:mute_state', { roomId: ROOM, isMuted: true });
  const vuParC = recus(sockC, 'group:mute_state');
  assert.strictEqual(
    vuParC.length, 1,
    'l\'arrivant doit voir les autres couper le leur — l\'autre moitié du défaut',
  );
  assert.strictEqual(vuParC[0].payload.userId, String(A));

  // ── Et la caméra suit le même chemin ─────────────────────────────────────
  await sockC.trigger('group:video_state', { roomId: ROOM, isVideoOn: false });
  const camVueParB = recus(sockB, 'group:video_state');
  assert.strictEqual(camVueParB.length, 1, 'la caméra de l\'arrivant se voit aussi');
  assert.strictEqual(camVueParB[0].payload.isVideoOn, false);

  if (groupRooms._reset) groupRooms._reset();
  await ownership.release(ROOM);
  console.log('groupMuteAfterJoin.test.js OK');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
