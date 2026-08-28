// Le chemin de déconnexion d'un appel de groupe.
//
// Il y a deux modes de panne et un seul demande une grâce.
//
// Le mode dominant est que le participant est DÉJÀ REVENU quand la déconnexion
// s'exécute : Socket.IO ne constate la chute qu'au bout de son ping (25 s
// d'intervalle, 20 s de patience), alors que le client se reconnecte et rejoue
// `join_group_call` en deux secondes. Annoncer un départ à ce moment-là
// expulsait quelqu'un de présent.
//
// Le mode minoritaire est la chute constatée avant le retour : la place est
// tenue quinze secondes, et l'annonce n'est faite qu'à l'échéance.
const assert = require('assert');
const pool = require('../../config/db');
const groupRooms = require('../state/groupRooms');
const ownership = require('../state/callDeviceOwnership');
const { armGroupRoomGraceOnDisconnect, leaveGroupCall } = require('./calls');
const { handleGroupRoomDisconnectGrace, setIo } = require('../../services/groupRoomWorkers');

const ROOM = 'room_grace';
const A = 7701; // organisateur, reste
const B = 7702; // celui dont la socket tombe

const EMIS = [];
const fakeIo = () => ({
  sockets: { adapter: { rooms: new Map(), sockets: new Map() } },
  to(room) { return { emit(event, payload) { EMIS.push({ room, event, payload }); } }; },
  in() { return { socketsLeave() {}, fetchSockets: async () => [] }; },
  socketsLeave() {},
});

function fakeSocket(userId, { socketId, room = ROOM } = {}) {
  const handlers = {};
  return {
    id: socketId ?? `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: `dev_${userId}`,
    currentGroupRoom: room,
    emit(event, payload) { EMIS.push({ room: 'self', event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    to(r) { return { emit(event, payload) { EMIS.push({ room: r, event, payload }); } }; },
    leave() {}, join() {},
    async trigger(event, data) { await handlers[event](data); },
  };
}

const departs = () => EMIS.filter((e) => e.event === 'group_user_left');

async function poser({ socketDeB = `sock_${B}` } = {}) {
  EMIS.length = 0;
  groupRooms._reset();
  await ownership.release(ROOM);
  await groupRooms.create(ROOM, { isVideo: true, ownerID: A, ownerInfo: null });
  await groupRooms.join(ROOM, B, { userName: 'B' });
  for (const [uid, sid] of [[A, `sock_${A}`], [B, socketDeB]]) {
    await ownership.setActive(ROOM, uid, { activeDeviceId: `dev_${uid}`, activeSocketId: sid });
  }
}

async function main() {
  setIo(fakeIo());

  // ── 1) Socket périmée : le revenant tient déjà la place ──────────────────
  // L'ownership porte la socket NEUVE ; c'est l'ancienne qui tombe.
  await poser({ socketDeB: 'sock_neuve' });
  await armGroupRoomGraceOnDisconnect(fakeIo(), fakeSocket(B, { socketId: 'sock_vieille' }));

  assert.strictEqual(
    departs().length, 0,
    'une socket périmée n\'annonce aucun départ',
  );
  assert.strictEqual(
    await groupRooms.getGrace(ROOM, B), null,
    'et n\'arme aucune grâce : il n\'est jamais parti',
  );
  assert.strictEqual(
    await ownership.getActiveDeviceId(ROOM, B), `dev_${B}`,
    'son appareil reste le sien — le libérer ferait perdre la place au revenant',
  );

  // ── 2) Chute réelle : grâce armée, appareil rendu, rien d'annoncé ────────
  await poser();
  await armGroupRoomGraceOnDisconnect(fakeIo(), fakeSocket(B));

  const jeton = await groupRooms.getGrace(ROOM, B);
  assert.ok(jeton, 'une chute réelle arme bien une grâce');
  assert.strictEqual(
    departs().length, 0,
    'mais n\'annonce rien tout de suite — c\'est tout l\'objet de la grâce',
  );
  assert.ok(
    (await groupRooms.get(ROOM)).participants.has(B),
    'sa place est tenue',
  );
  assert.strictEqual(
    await ownership.getActiveDeviceId(ROOM, B), null,
    'son appareil est rendu, pour qu\'il puisse revenir depuis un autre',
  );

  // ── 3) L'échéance annonce, une seule fois ───────────────────────────────
  EMIS.length = 0;
  const consomme = await handleGroupRoomDisconnectGrace({ roomID: ROOM, userID: B, jeton });
  assert.strictEqual(consomme, true);
  assert.strictEqual(departs().length, 1, 'le départ est annoncé à l\'échéance');
  assert.strictEqual(departs()[0].payload.userId, String(B));
  assert.strictEqual(departs()[0].payload.roomId, ROOM);
  assert.ok(
    !(await groupRooms.get(ROOM)).participants.has(B),
    'et la place est enfin libérée',
  );

  EMIS.length = 0;
  const rejeu = await handleGroupRoomDisconnectGrace({ roomID: ROOM, userID: B, jeton });
  assert.strictEqual(rejeu, false, 'le même job rejoué ne fait rien');
  assert.strictEqual(departs().length, 0, 'et n\'annonce pas un second départ');

  // ── 4) Retour avant l'échéance : le job périmé est inoffensif ────────────
  await poser();
  await armGroupRoomGraceOnDisconnect(fakeIo(), fakeSocket(B));
  const ancien = await groupRooms.getGrace(ROOM, B);
  assert.ok(ancien);

  const retour = await groupRooms.join(ROOM, B, { userName: 'B' });
  assert.strictEqual(retour.reprise, true, 'le retour se sait retour');

  EMIS.length = 0;
  const apresRetour = await handleGroupRoomDisconnectGrace({
    roomID: ROOM, userID: B, jeton: ancien,
  });
  assert.strictEqual(apresRetour, false);
  assert.strictEqual(
    departs().length, 0,
    'le job en vol au moment du retour ne doit annoncer aucun départ',
  );
  assert.ok(
    (await groupRooms.get(ROOM)).participants.has(B),
    'et surtout ne pas éjecter celui qui vient de revenir',
  );

  // ── 5) Socket sans identité : aucune charge utile ne porte "null" ────────
  await poser();
  EMIS.length = 0;
  const anonyme = fakeSocket(B);
  anonyme.alanyaID = null;
  await armGroupRoomGraceOnDisconnect(fakeIo(), anonyme);
  assert.strictEqual(departs().length, 0, 'rien n\'est annoncé sans identité');
  assert.ok(
    !JSON.stringify(EMIS).includes('"null"'),
    'l\'annonce vivait hors de la garde d\'identité et diffusait userId "null"',
  );

  // ── 6) Départ volontaire sans roomId : le salon est bien purgé ───────────
  await poser();
  EMIS.length = 0;
  const sockB = fakeSocket(B);
  leaveGroupCall(fakeIo(), sockB, new Map());
  await sockB.trigger('leave_group_call', {}); // payload sans roomId

  assert.ok(
    !(await groupRooms.get(ROOM)).participants.has(B),
    'le repli sur currentGroupRoom doit précéder le retrait — sinon le départ '
    + 'était annoncé alors que rien n\'était purgé, et un fantôme restait',
  );
  assert.strictEqual(departs().length, 1, 'et le départ est bien annoncé');

  // ── 7) Un identifiant de salon aberrant est refusé ───────────────────────
  await poser();
  EMIS.length = 0;
  const sockMauvais = fakeSocket(B);
  // Le handler de join est monté sur cette socket ; on lui donne une salle
  // dont l'identifiant contient un joker Redis.
  const { joinGroupCall } = require('./calls');
  joinGroupCall(fakeIo(), sockMauvais, new Map());
  await sockMauvais.trigger('join_group_call', { roomId: 'alanya:*', userName: 'B' });
  const erreur = EMIS.find((e) => e.event === 'call_error');
  assert.ok(erreur, 'un identifiant de salon aberrant est refusé');
  assert.strictEqual(erreur.payload.code, 'INVALID_ROOM_ID');

  groupRooms._reset();
  await ownership.release(ROOM);
  console.log('groupDisconnectGrace.test.js OK');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
