// Libération de l'ownership d'appareil sur les sorties de groupe et de session.
// Entrée C3 de l'audit des appels.
//
// `callDeviceOwnership.release()` n'était appelé que sur le chemin 1-à-1 et dans
// `failInvite`. Ni `leave_group_call`, ni `end_group_call`, ni le nettoyage de
// déconnexion, ni une session terminée normalement ne libéraient quoi que ce
// soit. L'entrée restait donc `active` sur l'appareil parti : rejoindre la même
// salle depuis un autre appareil renvoyait CALL_ANSWERED_ELSEWHERE, et pas
// seulement une fois — définitivement.
const assert = require('assert');
const pool = require('../../config/db');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const groupRooms = require('../state/groupRooms');
const { leaveGroupCall, endGroupCall, armGroupRoomGraceOnDisconnect } = require('./calls');

const OWNER = 1101;
const MEMBRE = 1102;
const ROOM = 'room_c3';

function fakeSocket(userId, { room = ROOM } = {}) {
  const handlers = {};
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: `dev_${userId}`,
    currentGroupRoom: room,
    emit() {},
    on(event, handler) { handlers[event] = handler; },
    to() { return { emit() {} }; },
    leave() {},
    async trigger(event, data) { await handlers[event](data); },
  };
}

const fakeIo = () => {
  const emits = [];
  return {
    sockets: { adapter: { rooms: new Map(), sockets: new Map() } },
    to(room) {
      return { emit(event, payload) { emits.push({ room, event, payload }); } };
    },
    // `end_group_call` vide la room après avoir émis : sans `in`, le handler
    // levait et son `catch` avalait la fin de l'exécution.
    in() { return { socketsLeave() {} }; },
    socketsLeave() {},
    get emits() { return emits; },
  };
};

async function poserOwnership(ids) {
  for (const id of ids) {
    await callDeviceOwnership.setActive(ROOM, id, {
      activeDeviceId: `dev_${id}`,
      // Doit correspondre à `fakeSocket.id` : la déconnexion compare les deux
      // pour distinguer une socket périmée d'une chute réelle.
      activeSocketId: `sock_${id}`,
    });
  }
}

async function reset() {
  await callDeviceOwnership.release(ROOM);
  if (groupRooms._reset) groupRooms._reset();
}

async function main() {
  const userSockets = new Map();

  // ── 1) Un participant quitte : lui seul est libéré ───────────────────────
  await reset();
  await poserOwnership([OWNER, MEMBRE]);

  const sock = fakeSocket(MEMBRE);
  leaveGroupCall(fakeIo(), sock, userSockets);
  await sock.trigger('leave_group_call', { roomId: ROOM });

  assert.strictEqual(
    await callDeviceOwnership.getActiveDeviceId(ROOM, MEMBRE),
    null,
    'le partant libère son appareil — sinon il ne peut plus revenir d\'ailleurs',
  );
  assert.strictEqual(
    await callDeviceOwnership.getActiveDeviceId(ROOM, OWNER),
    'dev_' + OWNER,
    'les autres gardent la leur : un départ n\'est pas une fin d\'appel',
  );

  // ── 2) Il peut revenir depuis un autre appareil ──────────────────────────
  // Reproduit ce que fait `join_group_call` : si aucune entrée n'existe, on
  // sonne, puis on revendique. C'est pour cela que le départ doit *oublier*
  // l'entrée et non la marquer « left » — `tryClaim` refuse cet état-là
  // (CALL_LEFT), ce qui aurait remplacé un refus par un autre.
  assert.strictEqual(
    await callDeviceOwnership.getEntry(ROOM, MEMBRE),
    null,
    'le départ oublie l\'entrée, il ne la marque pas',
  );
  await callDeviceOwnership.ring(ROOM, MEMBRE);
  const reclaim = await callDeviceOwnership.tryClaim(
    ROOM, MEMBRE, 'dev_autre', 'sock_autre',
  );
  assert.strictEqual(
    reclaim.ok, true,
    'rejoindre depuis un second appareil était refusé définitivement',
  );
  assert.strictEqual(
    await callDeviceOwnership.getActiveDeviceId(ROOM, MEMBRE),
    'dev_autre',
    'et c\'est bien le nouvel appareil qui possède la place',
  );

  // ── 3) Déconnexion brutale : l'appareil est rendu, la place est tenue ────
  await reset();
  await poserOwnership([OWNER, MEMBRE]);
  await groupRooms.create(ROOM, { ownerID: OWNER });
  await groupRooms.join(ROOM, MEMBRE);
  const ioDrop = fakeIo();
  const sockDrop = fakeSocket(MEMBRE);
  await armGroupRoomGraceOnDisconnect(ioDrop, sockDrop);
  assert.strictEqual(
    await callDeviceOwnership.getActiveDeviceId(ROOM, MEMBRE),
    null,
    'une socket qui tombe rend sa place, sinon la reconnexion se heurte à elle-même',
  );
  assert.ok(
    await groupRooms.getGrace(ROOM, MEMBRE),
    'mais sa place dans le salon est tenue par une grâce',
  );
  assert.strictEqual(
    ioDrop.emits.filter((e) => e.event === 'group_user_left').length, 0,
    'et son départ n\'est PAS annoncé dans la seconde — c\'est tout l\'objet de la grâce',
  );

  // ── 4) Fin de salle : plus personne ne possède rien ──────────────────────
  await reset();
  await poserOwnership([OWNER, MEMBRE]);
  await groupRooms.create(ROOM, { ownerID: OWNER });
  await groupRooms.join(ROOM, MEMBRE);

  const ioEnd = fakeIo();
  const sockOwner = fakeSocket(OWNER);
  endGroupCall(ioEnd, sockOwner, userSockets);
  await sockOwner.trigger('end_group_call', { roomId: ROOM });

  for (const id of [OWNER, MEMBRE]) {
    assert.strictEqual(
      await callDeviceOwnership.getActiveDeviceId(ROOM, id),
      null,
      `la salle détruite libère ${id}`,
    );
  }

  // ── 5) Et l'événement dit de quelle salle il parle ───────────────────────
  const ended = ioEnd.emits.find((e) => e.event === 'group_call_ended');
  assert.ok(ended, 'group_call_ended émis');
  assert.strictEqual(
    ended.payload.roomId, ROOM,
    'le payload était vide : le client ne pouvait pas distinguer la fin de SA '
    + 'salle de celle d\'une précédente',
  );

  await reset();
  console.log('ownershipRelease.test.js OK');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
