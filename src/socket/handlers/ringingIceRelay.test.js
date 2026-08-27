// Candidats ICE émis pendant la sonnerie : gardés, puis rejoués au décrochage.
//
// Rejoue le scénario réel qui coûtait une vingtaine de secondes de silence au
// début de chaque appel : l'appelant rassemble ses candidats une à deux
// secondes après avoir créé son offre, donc pendant que le téléphone d'en face
// sonne. À ce moment le destinataire n'a pas encore d'appareil actif, et le
// relais n'a nulle part où router. Comme `onIceCandidate` ne repasse jamais par
// un candidat déjà émis, le destinataire décrochait sans un seul candidat
// distant : aucune paire à tester, et une allocation TURN sans permission, donc
// sourde aux tests de connectivité de l'appelant.
const assert = require('assert');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const pendingIce = require('../state/pendingIce');
const { iceCandidate, answerCall } = require('./calls');
const { deviceRoom } = require('../../utils/deviceId');

const CALLER = 501;
const CALLEE = 502;
const CALL_KEY = '9001';
const DEV_CALLER = 'dev_caller';
const DEV_CALLEE = 'dev_callee';

async function reset() {
  for (const id of [CALLER, CALLEE]) await callState.clear(id);
  await callDeviceOwnership.release(CALL_KEY);
  await pendingIce.clear(CALL_KEY, CALLEE);
  await pendingIce.clear(CALL_KEY, CALLER);
}

/// L'état que `call_user` laisse derrière lui : l'appelant possède son
/// appareil, le destinataire sonne (donc sans appareil actif), et les deux
/// portent une entrée callState — c'est cette dernière qui manquait à
/// l'appelant tant que `setRinging` était posé en fin de handler.
async function ringingState() {
  await callDeviceOwnership.setCalling(CALL_KEY, CALLER, {
    activeDeviceId: DEV_CALLER,
    activeSocketId: 's_caller',
  });
  await callDeviceOwnership.ring(CALL_KEY, CALLEE);
  await callState.setRinging(CALLEE, { callId: CALL_KEY, peerId: CALLER, isVideo: true });
  await callState.setRinging(CALLER, { callId: CALL_KEY, peerId: CALLEE, isVideo: true });
}

function fakeSocket(userId, deviceId) {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${userId}_${deviceId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId,
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    async trigger(event, data) { await handlers[event](data); },
    get emitted() { return emitted; },
  };
}

function fakeIo() {
  const roomEmits = [];
  return {
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return {
        emit(event, payload) { roomEmits.push({ room, event, payload }); },
      };
    },
    get roomEmits() { return roomEmits; },
  };
}

const candidate = (n) => ({
  candidate: `candidate:${n} 1 udp 2122260223 10.0.0.${n} 5000 typ host`,
  sdpMid: '0',
  sdpMLineIndex: 0,
});

async function main() {
  const userSockets = new Map();

  // ── 1) Pendant la sonnerie : rien n'est relayé, mais rien n'est perdu ──────
  await reset();
  await ringingState();

  const io = fakeIo();
  const callerSock = fakeSocket(CALLER, DEV_CALLER);
  iceCandidate(io, callerSock, userSockets);

  for (let n = 1; n <= 3; n += 1) {
    await callerSock.trigger('ice_candidate', {
      targetUserId: String(CALLEE),
      candidate: candidate(n),
      generation: 0,
      callId: CALL_KEY,
    });
  }

  assert.strictEqual(
    io.roomEmits.length, 0,
    'rien à relayer tant que le destinataire n\'a pas d\'appareil actif',
  );

  // ── 2) Au décrochage : les candidats gardés partent vers son appareil ─────
  const ioAnswer = fakeIo();
  const calleeSock = fakeSocket(CALLEE, DEV_CALLEE);
  answerCall(ioAnswer, calleeSock, userSockets);
  await calleeSock.trigger('answer_call', {
    callerId: String(CALLER),
    callId: CALL_KEY,
    answer: { sdp: 'v=0', type: 'answer' },
  });

  const noError = calleeSock.emitted.find((e) => e.event === 'call_error');
  assert.ok(!noError, `answer_call refusé : ${JSON.stringify(noError)}`);

  const replayed = ioAnswer.roomEmits.filter((e) => e.event === 'ice_candidate');
  assert.strictEqual(replayed.length, 3, 'les trois candidats sont rejoués');
  for (const e of replayed) {
    assert.strictEqual(
      e.room, deviceRoom(CALLEE, DEV_CALLEE),
      'rejoués vers l\'appareil qui vient de décrocher, pas en fan-out',
    );
  }
  assert.strictEqual(
    replayed[0].payload.candidate.candidate, candidate(1).candidate,
    'ordre de collecte préservé',
  );
  assert.strictEqual(
    replayed[2].payload.candidate.candidate, candidate(3).candidate,
    'ordre de collecte préservé',
  );
  assert.strictEqual(replayed[1].payload.generation, 0, 'génération transmise');

  // ── 3) Le tampon est vidé : pas de rejeu en double ────────────────────────
  assert.deepStrictEqual(
    await pendingIce.drain(CALL_KEY, CALLEE), [],
    'le décrochage a vidé le tampon',
  );

  // ── 4) Après le décrochage, le relais redevient direct ────────────────────
  const ioLive = fakeIo();
  const callerSock2 = fakeSocket(CALLER, DEV_CALLER);
  iceCandidate(ioLive, callerSock2, userSockets);
  await callerSock2.trigger('ice_candidate', {
    targetUserId: String(CALLEE),
    candidate: candidate(9),
    generation: 0,
    callId: CALL_KEY,
  });
  const live = ioLive.roomEmits.filter((e) => e.event === 'ice_candidate');
  assert.strictEqual(live.length, 1, 'candidat tardif relayé immédiatement');
  assert.strictEqual(live[0].room, deviceRoom(CALLEE, DEV_CALLEE));
  assert.deepStrictEqual(
    await pendingIce.drain(CALL_KEY, CALLEE), [],
    'un candidat relayé n\'est pas mis en tampon',
  );

  // ── 5) Sans entrée callState pour l'appelant, tout est perdu ──────────────
  // C'est la fenêtre que `call_user` laissait ouverte en posant `setRinging`
  // après l'insertion en base et l'émission d'incoming_call : les premiers
  // candidats arrivaient avant, et sortaient à la toute première garde — sans
  // même atteindre le tampon. Ce cas documente pourquoi l'ordre a changé.
  await reset();
  await callDeviceOwnership.setCalling(CALL_KEY, CALLER, {
    activeDeviceId: DEV_CALLER,
    activeSocketId: 's_caller',
  });
  await callDeviceOwnership.ring(CALL_KEY, CALLEE);
  // volontairement : pas de callState.setRinging(CALLER, …)

  const ioEarly = fakeIo();
  const earlySock = fakeSocket(CALLER, DEV_CALLER);
  iceCandidate(ioEarly, earlySock, userSockets);
  await earlySock.trigger('ice_candidate', {
    targetUserId: String(CALLEE),
    candidate: candidate(1),
    generation: 0,
    callId: CALL_KEY,
  });
  assert.strictEqual(ioEarly.roomEmits.length, 0, 'rien de relayé');
  assert.deepStrictEqual(
    await pendingIce.drain(CALL_KEY, CALLEE), [],
    'sans état d\'appel côté appelant, le candidat n\'atteint pas le tampon '
      + '— d\'où l\'ordre imposé dans call_user',
  );

  await reset();
  console.log('ringingIceRelay.test.js OK');
  // Sortie explicite : answer_call déclenche un envoi FCM en tâche de fond
  // (rattrapé, mais il garde la boucle d'événements armée). Voir C6.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
