// call_conf_join : toute sortie dit pourquoi. Entrée C5 de l'audit des appels.
//
// Sans invitation en attente, le handler sortait en silence : l'invité restait
// sur un écran qui tourne, et le client n'avait aucun moyen de distinguer un
// refus d'une lenteur réseau. Les autres sorties du même handler émettent
// toutes un `call_error`.
const assert = require('assert');
const pool = require('../../config/db');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const { confJoin } = require('./calls');

const INVITEE = 704;

function fakeSocket(userId, deviceId) {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId,
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers[event] = handler; },
    async trigger(event, data) { await handlers[event](data); },
    get emitted() { return emitted; },
  };
}

const fakeIo = () => ({
  sockets: { adapter: { rooms: new Map() } },
  to: () => ({ emit() {} }),
});

async function main() {
  const userSockets = new Map();

  // ── Aucune invitation en attente : erreur explicite ──────────────────────
  await callState.clear(INVITEE);
  if (callSessions._reset) callSessions._reset();

  const sock = fakeSocket(INVITEE, 'dev_invitee');
  confJoin(fakeIo(), sock, userSockets);
  await sock.trigger('call_conf_join', {});

  const err = sock.emitted.find((e) => e.event === 'call_error');
  assert.ok(err, 'une sortie sans invitation doit dire pourquoi');
  assert.strictEqual(
    err.payload.code, 'CALL_INVITE_NOT_PENDING',
    'code dédié, distinguable d\'un problème d\'appareil',
  );

  // ── Appareil non identifié : l'erreur historique reste ────────────────────
  const sockNoDevice = fakeSocket(INVITEE, null);
  confJoin(fakeIo(), sockNoDevice, userSockets);
  await sockNoDevice.trigger('call_conf_join', {});
  assert.strictEqual(
    sockNoDevice.emitted[0]?.payload?.code, 'DEVICE_ID_REQUIRED',
    'la garde d\'appareil passe avant, et garde son code',
  );

  await callState.clear(INVITEE);
  console.log('confJoinErrors.test.js OK');
  // Le pool MySQL garde ses connexions : sans cette libération, le
  // processus ne rend pas la main — voir C6.
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
