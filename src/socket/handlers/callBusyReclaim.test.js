// Régression false-busy : reclaimStaleBusy purge un état ringing/in_call fantôme
// (utilisateur sans socket + sans grâce de reconnexion) pour ne pas renvoyer un
// faux call_busy. Voir calls.js + presence.js (cluster B).
//
// reclaimStaleBusy (et isUserOnline qu'elle appelle) sont async depuis
// l'intégration Redis (phase 1) — fetchSockets() cross-instance plutôt qu'une
// lecture locale de l'adapter. Voir src/testUtils/fakeIo.js.
const assert = require('assert');
const { reclaimStaleBusy } = require('./calls');
const callState = require('../state/callState');
const pendingCalls = require('../state/pendingCalls');
const { makeFakeIo, fakeSocket } = require('../../testUtils/fakeIo');

function fakeIo(online = []) {
  return makeFakeIo(online.map((id) => fakeSocket(`s-${id}`, { userId: id })));
}

function reset() {
  [1, 2, 3].forEach((id) => {
    callState.clear(id);
    pendingCalls.clear(id);
  });
}

(async () => {
  // 1) in_call orphelin (offline, sans grâce) → purgé des deux côtés.
  reset();
  callState.setInCall(2, { callId: '500', peerId: 1 });
  callState.setInCall(1, { callId: '500', peerId: 2 });
  pendingCalls.set(2, { callId: '500' });
  assert.strictEqual(await reclaimStaleBusy(fakeIo([]), 2), true, 'orphelin récupéré');
  assert.strictEqual(callState.get(2), 'idle', 'cible nettoyée');
  assert.strictEqual(callState.get(1), 'idle', 'pair nettoyé');
  assert.strictEqual(pendingCalls.get(2), null, 'pending nettoyé');

  // 2) in_call mais EN LIGNE → conservé (appel en arrière-plan légitime).
  reset();
  callState.setInCall(2, { callId: '501', peerId: 1 });
  assert.strictEqual(await reclaimStaleBusy(fakeIo([2]), 2), false, 'en ligne = non purgé');
  assert.strictEqual(callState.get(2), 'in_call', 'en ligne conservé');

  // 3) in_call offline MAIS grâce de reconnexion armée → conservé.
  reset();
  callState.setInCall(2, { callId: '502', peerId: 1 });
  const entry = callState.getEntry(2);
  entry.disconnectTimer = setTimeout(() => {}, 60000);
  assert.strictEqual(await reclaimStaleBusy(fakeIo([]), 2), false, 'grâce = non purgé');
  assert.strictEqual(callState.get(2), 'in_call', 'grâce conservée');
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;

  // 4) idle → no-op.
  reset();
  assert.strictEqual(await reclaimStaleBusy(fakeIo([]), 2), false, 'idle = no-op');

  // 5) pair engagé dans un AUTRE appel → seule la cible est purgée.
  reset();
  callState.setInCall(2, { callId: '503', peerId: 1 });
  callState.setInCall(1, { callId: '999', peerId: 3 });
  assert.strictEqual(await reclaimStaleBusy(fakeIo([]), 2), true, 'cible récupérée');
  assert.strictEqual(callState.get(2), 'idle', 'cible nettoyée');
  assert.strictEqual(callState.get(1), 'in_call', 'pair non lié conservé');

  reset();
  console.log('callBusyReclaim.test.js OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
