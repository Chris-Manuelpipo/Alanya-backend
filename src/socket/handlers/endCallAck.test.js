// `end_call` doit accuser réception — y compris pour refuser.
//
// Sans accusé, l'émetteur ne peut pas distinguer un socket vivant d'un socket
// zombie : le TCP est tombé, mais Socket.IO ne le constate qu'au bout de son
// ping (25 s d'intervalle, 20 s de patience). Le raccrochage part dans le vide,
// personne ne prévient le pair, et celui-ci reste sur « Reconnexion… » jusqu'à
// son propre délai. Le cas est d'autant plus probable que l'appel a duré.
//
// Aucune base de données n'est touchée : les cas couverts sortent tous avant
// l'écriture d'historique.
const assert = require('assert');
const { endCall } = require('./calls');
const callState = require('../state/callState');

const CHRIS = 1;

/** Socket factice qui retient les handlers enregistrés par `endCall`. */
function fakeSocket({ authenticated = true } = {}) {
  const handlers = {};
  return {
    handlers,
    authenticated,
    alanyaID: CHRIS,
    currentCallID: null,
    currentCallTarget: null,
    on(event, fn) {
      handlers[event] = fn;
    },
    emit() {},
  };
}

const fakeIo = { to: () => ({ emit: () => {} }) };

/** Enregistre le handler et l'invoque, en rendant l'accusé reçu. */
async function raccrocher(socket, data = {}) {
  endCall(fakeIo, socket, new Map());
  let accuse = 'JAMAIS_APPELE';
  await socket.handlers.end_call(data, (r) => {
    accuse = r;
  });
  return accuse;
}

(async () => {
  // ── Socket non authentifié : un refus explicite, pas un silence ──────────
  {
    const socket = fakeSocket({ authenticated: false });
    const accuse = await raccrocher(socket, { targetUserId: 2 });
    assert.deepStrictEqual(
      accuse,
      { ok: false, reason: 'unauthenticated' },
      'le silence laissait le client croire son raccrochage transmis ; '
      + 'un refus explicite le fait remettre en file et reconstruire son socket',
    );
  }

  // ── Déjà hors appel : traité, donc accusé favorablement ──────────────────
  {
    await callState.clear(CHRIS);
    const socket = fakeSocket();
    const accuse = await raccrocher(socket, { targetUserId: 2 });
    assert.deepStrictEqual(
      accuse,
      { ok: true, handled: 'already_idle' },
      'un second end_call (rejeu, ou double appui CallKit) est bien reçu : '
      + 'le client ne doit pas le rejouer indéfiniment',
    );
  }

  // ── Ancien client, sans fonction d'accusé : rien ne doit lever ───────────
  {
    await callState.clear(CHRIS);
    const socket = fakeSocket();
    endCall(fakeIo, socket, new Map());
    await socket.handlers.end_call({ targetUserId: 2 });
    assert.strictEqual(
      socket.currentCallID,
      null,
      'le handler doit s\'exécuter normalement quand aucun accusé n\'est '
      + 'attendu — le parc installé n\'en envoie pas',
    );
  }

  console.log('endCallAck.test.js OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
