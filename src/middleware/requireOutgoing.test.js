// Le verrou de l'émission, à chaque point d'entrée : un compte dont l'essai est
// fini et qui n'a pas d'abonnement ne fait que recevoir.
//
// Le verrou (outgoingGate) est remplacé par un double : ce test éprouve le
// BRANCHEMENT — chaque entrée refuse avant d'écrire quoi que ce soit, avec le
// code que le téléphone attend — pas la règle, qu'outgoingGate.test.js et
// rules.test.js couvrent. Aucune base n'est lue : un refus part avant.
const assert = require('assert');

const verdicts = new Map(); // alanyaID -> allowed
const asked = [];
const gatePath = require.resolve('../services/billing/outgoingGate');
require.cache[gatePath] = {
  id: gatePath,
  filename: gatePath,
  loaded: true,
  exports: {
    checkOutgoing: async (id) => { asked.push(id); return { allowed: verdicts.get(id) !== false }; },
    invalidateOutgoing: () => {},
    OUTGOING_DENIED: {
      code: 'SUBSCRIPTION_REQUIRED', feature: 'outgoing', message: 'Envoyer et appeler sont réservés aux abonnés',
    },
  },
};

const requireOutgoing = require('./requireOutgoing');
const { messageSend } = require('../socket/handlers/chat/messageSend');
const calls = require('../socket/handlers/calls');
const { meetingChat } = require('../socket/handlers/meetings');

const MUET = 41; // essai fini, aucun abonnement
const ABONNE = 42;
verdicts.set(MUET, false);

function fakeSocket(alanyaID, deviceId = 'dev-1') {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${alanyaID}`,
    alanyaID,
    authenticated: true,
    deviceId,
    currentMeetingID: 9,
    emit(event, payload) { emitted.push({ event, payload }); },
    join() {},
    on(event, handler) { handlers[event] = handler; },
    async trigger(event, data, ack) { await handlers[event](data, ack); },
    get emitted() { return emitted; },
  };
}

(async () => {
  // ── REST ─────────────────────────────────────────────────────────────────
  {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    await requireOutgoing({ user: { alanyaID: MUET } }, res, () => { passed = true; });
    assert.strictEqual(passed, false, 'refusé');
    assert.strictEqual(res.code, 403);
    assert.strictEqual(res.body.code, 'SUBSCRIPTION_REQUIRED');
    assert.strictEqual(res.body.feature, 'outgoing', 'le panneau de l\'offre sait pourquoi');
    assert.ok(res.body.error);

    const ok = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
    let next = false;
    await requireOutgoing({ user: { alanyaID: ABONNE } }, ok, () => { next = true; });
    assert.strictEqual(next, true, 'abonné : la requête passe');
    assert.strictEqual(ok.code, null);
  }

  // ── socket message:send : la bulle passe en échec, avec son clientId ─────
  {
    const socket = fakeSocket(MUET);
    messageSend({}, socket);
    await socket.trigger('message:send', { conversationID: 5, content: 'bonjour', clientId: 'c-1' });
    const failed = socket.emitted.find((e) => e.event === 'message:send_failed');
    assert.ok(failed, 'message:send_failed émis');
    assert.deepStrictEqual(failed.payload, {
      clientId: 'c-1',
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Envoyer et appeler sont réservés aux abonnés',
      feature: 'outgoing',
    });
    const err = socket.emitted.find((e) => e.event === 'error');
    assert.strictEqual(err.payload.code, 'SUBSCRIPTION_REQUIRED');
    assert.strictEqual(socket.emitted.filter((e) => e.event === 'message:sent').length, 0, 'rien n\'est écrit');
  }

  // ── socket call_user ─────────────────────────────────────────────────────
  {
    const socket = fakeSocket(MUET);
    calls.callUser({}, socket, new Map());
    await socket.trigger('call_user', { targetUserId: 7, offer: { sdp: 'x' }, isVideo: false });
    const failed = socket.emitted.find((e) => e.event === 'call_failed');
    assert.ok(failed, 'call_failed émis');
    assert.strictEqual(failed.payload.code, 'SUBSCRIPTION_REQUIRED');
    assert.strictEqual(failed.payload.feature, 'outgoing');
  }

  // ── socket create_group_call ─────────────────────────────────────────────
  {
    const socket = fakeSocket(MUET);
    calls.createGroupCall({}, socket, new Map());
    await socket.trigger('create_group_call', { roomId: 'room-1', isVideo: false, targetUserIds: [7, 8] });
    const failed = socket.emitted.find((e) => e.event === 'call_error');
    assert.ok(failed, 'call_error émis');
    assert.strictEqual(failed.payload.code, 'SUBSCRIPTION_REQUIRED');
    assert.strictEqual(failed.payload.feature, 'outgoing');
  }

  // ── socket call_add_participant ──────────────────────────────────────────
  {
    const socket = fakeSocket(MUET);
    calls.addParticipant({}, socket, new Map());
    await socket.trigger('call_add_participant', { targetUserId: 7 });
    const rejected = socket.emitted.find((e) => e.event === 'call_add_rejected');
    assert.ok(rejected, 'call_add_rejected émis');
    assert.strictEqual(rejected.payload.code, 'SUBSCRIPTION_REQUIRED');
  }

  // ── socket meeting:chat : le message n'atteint personne ──────────────────
  {
    const socket = fakeSocket(MUET);
    const relayed = [];
    const io = { to: () => ({ emit: (...a) => relayed.push(a) }) };
    meetingChat(io, socket, new Map());
    await socket.trigger('meeting:chat', { meetingID: 9, userID: MUET, message: 'salut' });
    assert.strictEqual(relayed.length, 0, 'rien n\'est relayé à la réunion');
    assert.strictEqual(socket.emitted.find((e) => e.event === 'error').payload.code, 'SUBSCRIPTION_REQUIRED');

    // Un abonné écrit normalement.
    const ok = fakeSocket(ABONNE);
    meetingChat(io, ok, new Map());
    await ok.trigger('meeting:chat', { meetingID: 9, userID: ABONNE, message: 'salut' });
    assert.strictEqual(relayed.length, 1);
  }

  // ── Ce qui reste ouvert : décrocher ne passe par aucun verrou ────────────
  {
    const before = asked.length;
    const socket = fakeSocket(MUET);
    calls.answerCall({}, socket, new Map());
    // Aucun contrôle d'émission à l'entrée de answer_call : on n'en fait pas la demande.
    try { await socket.trigger('answer_call', { callerId: 7 }, () => {}); } catch { /* l'état d'appel est absent : sans importance ici */ }
    assert.strictEqual(asked.length, before, 'répondre à un appel n\'interroge pas le verrou');
  }

  console.log('requireOutgoing.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
