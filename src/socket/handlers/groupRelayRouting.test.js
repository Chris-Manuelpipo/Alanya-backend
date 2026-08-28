// Relais média de groupe : routage en session à trois, et solde du timer de
// reprise. Couvre les entrées C2 et C1 de l'audit des appels.
//
// C2 — `group:video_state` diffusait dans la room Socket.IO `group_<id>`, que
// les participants d'une conférence ne rejoignent jamais : `call_conf_join` ne
// fait aucun `socket.join`. Couper sa caméra à trois n'était donc jamais vu des
// autres, alors que le micro, lui, avait la branche de routage par appareil.
//
// C1 — `ice_candidate` solde le timer resume_ack (« signal média = preuve de
// session locale », pour les clients qui n'envoient pas `call_resume_ack`).
// `group_offer`, `group_answer` et `group_ice_candidate` portaient le même bloc
// de garde, copié sans cet appel : un participant qui reprenait par le seul
// maillage se faisait solder au bout de huit secondes.
const assert = require('assert');
const pool = require('../../config/db');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const callSessions = require('../state/callSessions');
const {
  groupVideoState,
  groupMuteState,
  groupOffer,
  groupAnswer,
  groupIceCandidate,
} = require('./calls');
const { deviceRoom } = require('../../utils/deviceId');

const A = 601; // inviteur
const B = 602; // pair d'origine
const C = 603; // invité
const DEV = { [A]: 'dev_a', [B]: 'dev_b', [C]: 'dev_c' };

async function reset() {
  for (const id of [A, B, C]) await callState.clear(id);
  if (callSessions._reset) callSessions._reset();
}

/// Ouvre une session à trois et y fait entrer l'invité, comme `call_add` puis
/// `call_conf_join`. Rend le sessionId, qui sert aussi de clé d'ownership.
async function conferenceOfThree() {
  const session = await callSessions.openWithPending({
    originCallId: 7777,
    isVideo: true,
    participants: [A, B],
    inviteeId: C,
    byUserId: A,
  });
  assert.ok(session, 'session ouverte');
  const { sessionId } = session;
  await callSessions.promotePending(sessionId);
  for (const id of [A, B, C]) {
    await callDeviceOwnership.setActive(sessionId, id, {
      activeDeviceId: DEV[id],
      activeSocketId: `s_${id}`,
    });
  }
  return sessionId;
}

function fakeSocket(userId, deviceId) {
  const handlers = {};
  const roomBroadcasts = [];
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId,
    currentGroupRoom: null,
    emit() {},
    on(event, handler) { handlers[event] = handler; },
    // `socket.to(room)` = diffusion à la room, le chemin des groupes classiques.
    to(room) {
      return { emit(event, payload) { roomBroadcasts.push({ room, event, payload }); } };
    },
    async trigger(event, data) { await handlers[event](data); },
    get roomBroadcasts() { return roomBroadcasts; },
  };
}

function fakeIo() {
  const deviceEmits = [];
  return {
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return { emit(event, payload) { deviceEmits.push({ room, event, payload }); } };
    },
    get deviceEmits() { return deviceEmits; },
  };
}

async function main() {
  const userSockets = new Map();

  // ── C2 : la caméra se propage en conférence, par appareil ─────────────────
  await reset();
  const sessionId = await conferenceOfThree();

  const io = fakeIo();
  const sockA = fakeSocket(A, DEV[A]);
  groupVideoState(io, sockA, userSockets);
  await sockA.trigger('group:video_state', { roomId: sessionId, isVideoOn: false });

  const videoEmits = io.deviceEmits.filter((e) => e.event === 'group:video_state');
  assert.strictEqual(videoEmits.length, 2, 'relayé aux deux autres participants');
  const rooms = videoEmits.map((e) => e.room).sort();
  assert.deepStrictEqual(
    rooms, [deviceRoom(B, DEV[B]), deviceRoom(C, DEV[C])].sort(),
    'vers les appareils owners, y compris celui qui a rejoint',
  );
  assert.strictEqual(videoEmits[0].payload.userId, String(A), 'émetteur identifié');
  assert.strictEqual(videoEmits[0].payload.isVideoOn, false, 'état transmis');
  assert.strictEqual(
    sockA.roomBroadcasts.length, 0,
    'pas de diffusion dans une room que personne ne rejoint',
  );

  // Le micro, lui, avait déjà ce routage : il doit continuer d'y passer.
  const io2 = fakeIo();
  const sockA2 = fakeSocket(A, DEV[A]);
  groupMuteState(io2, sockA2, userSockets);
  await sockA2.trigger('group:mute_state', { roomId: sessionId, isMuted: true });
  assert.strictEqual(
    io2.deviceEmits.filter((e) => e.event === 'group:mute_state').length, 2,
    'le micro garde son routage par appareil',
  );

  // ── C2 bis : un groupe classique reste sur la diffusion par room ──────────
  await reset();
  const ROOM = 'room_classique';
  for (const id of [A, B]) {
    await callDeviceOwnership.setActive(ROOM, id, {
      activeDeviceId: DEV[id],
      activeSocketId: `s_${id}`,
    });
  }
  const io3 = fakeIo();
  const sockGroup = fakeSocket(A, DEV[A]);
  groupVideoState(io3, sockGroup, userSockets);
  await sockGroup.trigger('group:video_state', { roomId: ROOM, isVideoOn: true });
  assert.strictEqual(io3.deviceEmits.length, 0, 'pas de routage par appareil hors session');
  assert.strictEqual(sockGroup.roomBroadcasts.length, 1, 'diffusion room conservée');
  assert.strictEqual(sockGroup.roomBroadcasts[0].room, `group_${ROOM}`);

  // ── C1 : les trois relais média soldent le timer de reprise ───────────────
  const relays = [
    ['group_offer', groupOffer, { offer: { sdp: 'v=0', type: 'offer' } }],
    ['group_answer', groupAnswer, { answer: { sdp: 'v=0', type: 'answer' } }],
    ['group_ice_candidate', groupIceCandidate, { candidate: { candidate: 'candidate:1' } }],
  ];

  for (const [event, register, extra] of relays) {
    await reset();
    const sid = await conferenceOfThree();
    await callState.setInCall(A, { callId: sid, peerId: B, isVideo: true });

    let expired = false;
    await callState.scheduleResumeAck(A, () => { expired = true; }, 5000);
    assert.strictEqual(
      await callState.hasResumeAckTimer(A), true,
      `${event} : timer de reprise armé avant le relais`,
    );

    const ioRelay = fakeIo();
    const sock = fakeSocket(A, DEV[A]);
    register(ioRelay, sock, userSockets);
    await sock.trigger(event, { toUserId: String(C), roomId: sid, ...extra });

    assert.strictEqual(
      await callState.hasResumeAckTimer(A), false,
      `${event} : le signal média solde le timer (sinon resume_ack_timeout à 8 s)`,
    );
    assert.strictEqual(expired, false, `${event} : le timer n'a pas expiré, il a été soldé`);
    assert.strictEqual(
      ioRelay.deviceEmits.filter((e) => e.event === event).length, 1,
      `${event} : relayé à l'appareil cible`,
    );
    assert.strictEqual(
      ioRelay.deviceEmits[0].room, deviceRoom(C, DEV[C]),
      `${event} : vers le bon appareil`,
    );
  }

  await reset();
  console.log('groupRelayRouting.test.js OK');
  // Le pool MySQL garde ses connexions : sans cette libération, le
  // processus ne rend pas la main — voir C6.
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
