// `answer_call` doit accuser réception avec la vérité, pas avec « ok ».
//
// Le `finally` du handler soldait toutes les sorties non traitées à `ok: true`,
// y compris celle où l'appel ne sonne plus. Le client en concluait que son
// décrochage avait abouti : il passait « connecté », démarrait son chronomètre
// et rouvrait une session CallKit sous un identifiant fabriqué — un appel en
// cours avec personne en face. Le code `CALL_NOT_RINGING` était pourtant émis
// juste à côté, mais un accusé favorable le contredisait.
//
// Aucune base de données n'est touchée : les cas couverts sortent tous avant
// l'écriture d'historique.
const assert = require('assert');
const { answerCall } = require('./calls');
const callState = require('../state/callState');

const CHRIS = 1;
const PAIR = 2;

/** Socket factice qui retient les handlers et les événements émis. */
function fakeSocket({ authenticated = true, deviceId = 'appareil-a' } = {}) {
  const handlers = {};
  const emitted = [];
  return {
    handlers,
    emitted,
    authenticated,
    alanyaID: CHRIS,
    deviceId,
    currentCallID: null,
    currentCallTarget: null,
    on(event, fn) {
      handlers[event] = fn;
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
}

const fakeIo = { to: () => ({ emit: () => {} }) };

/** Enregistre le handler et l'invoque, en rendant l'accusé reçu. */
async function repondre(socket, data = {}) {
  answerCall(fakeIo, socket, new Map());
  let accuse = 'JAMAIS_APPELE';
  await socket.handlers.answer_call(data, (r) => {
    accuse = r;
  });
  return accuse;
}

const REPONSE = { sdp: 'v=0', type: 'answer' };

(async () => {
  // ── Socket non authentifié ───────────────────────────────────────────────
  {
    const socket = fakeSocket({ authenticated: false });
    const accuse = await repondre(socket, { callerId: PAIR, answer: REPONSE, callId: 42 });
    assert.deepStrictEqual(accuse, { ok: false, reason: 'unauthenticated' });
  }

  // ── Données invalides : ni « ok », ni silence ────────────────────────────
  {
    const socket = fakeSocket();
    const accuse = await repondre(socket, { callerId: PAIR, callId: 42 });
    assert.deepStrictEqual(
      accuse,
      { ok: false, reason: 'invalid_data' },
      'sans réponse WebRTC il n\'y a rien à relayer : accuser « ok » laissait '
      + 'le client croire son décrochage transmis',
    );
  }

  // ── Sans identifiant d'appareil ──────────────────────────────────────────
  {
    const socket = fakeSocket({ deviceId: null });
    const accuse = await repondre(socket, { callerId: PAIR, answer: REPONSE, callId: 42 });
    assert.deepStrictEqual(accuse, { ok: false, reason: 'DEVICE_ID_REQUIRED' });
  }

  // ── Sans identifiant d'appel ─────────────────────────────────────────────
  {
    const socket = fakeSocket();
    const accuse = await repondre(socket, { callerId: PAIR, answer: REPONSE });
    assert.deepStrictEqual(accuse, { ok: false, reason: 'CALL_ID_REQUIRED' });
  }

  // ── L'appel ne sonne plus : le cœur du correctif ─────────────────────────
  {
    await callState.clear(CHRIS);
    await callState.clear(PAIR);
    const socket = fakeSocket();
    const accuse = await repondre(socket, { callerId: PAIR, answer: REPONSE, callId: 42 });

    assert.deepStrictEqual(
      accuse,
      { ok: false, reason: 'CALL_NOT_RINGING' },
      'le `finally` accusait « ok » : le client se croyait connecté à un appel '
      + 'que le serveur ne connaissait plus',
    );
    const erreur = socket.emitted.find((e) => e.event === 'call_error');
    assert.ok(erreur, 'le client doit aussi recevoir le code d\'erreur');
    assert.strictEqual(erreur.payload.code, 'CALL_NOT_RINGING');
    assert.strictEqual(
      erreur.payload.callId,
      '42',
      'le callId permet au client de ne solder que l\'appel visé',
    );
  }

  // ── Ancien client, sans fonction d'accusé : rien ne doit lever ───────────
  {
    await callState.clear(CHRIS);
    await callState.clear(PAIR);
    const socket = fakeSocket();
    answerCall(fakeIo, socket, new Map());
    await socket.handlers.answer_call({ callerId: PAIR, answer: REPONSE, callId: 42 });
    assert.strictEqual(
      socket.currentCallID,
      null,
      'le handler doit s\'exécuter normalement quand aucun accusé n\'est '
      + 'attendu — le parc installé n\'en envoie pas',
    );
  }

  console.log('answerCallAck.test.js OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
