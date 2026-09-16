// Une grâce de déconnexion ne doit pas retirer un appareil qui est revenu.
//
// Socket.IO ne constate la mort d'une socket qu'au terme de son ping — 25 s
// d'intervalle, 20 s de patience, valeurs par défaut conservées par server.js.
// L'application, elle, recrée la sienne en deux secondes. Le `disconnect` de
// l'ancienne arrivait donc APRÈS le retour et armait une grâce sur quelqu'un de
// présent ; quarante-cinq secondes plus tard il était retiré de son propre
// appel à trois sans avoir rien fait — et sans que rien ne le lui dise.
//
// Le chemin voisin des salons de groupe se garde de ce piège depuis longtemps
// (calls.js, armGroupRoomGraceOnDisconnect) ; celui des appels ne l'avait pas.
//
// La base est neutralisée : ce test porte sur la décision de retrait, pas sur
// l'historique.
const assert = require('assert');

// ── Doublures, posées AVANT de charger calls.js, qui fige ses imports ────────
const pool = require('../../config/db');
const sansLignes = async () => [[], []];
pool.query = sansLignes;
pool.execute = sansLignes;
pool.getConnection = async () => ({
  query: sansLignes,
  execute: sansLignes,
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release: () => {},
});

const notifications = require('../../services/notificationService');
notifications.notifyCallEnded = async () => {};

const { endActiveCallForUser } = require('./calls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const pendingCalls = require('../state/pendingCalls');
const { makeFakeIo, fakeSocket } = require('../../testUtils/fakeIo');

const CHRIS = 1;
const AWA = 2;
const ORIGIN = 77;
const APPAREIL = 'appareil-chris';

/** Un `io` où seuls les appareils listés ont une socket vivante. */
const ioAvecAppareils = (appareils) =>
  makeFakeIo(
    appareils.map((did, i) =>
      fakeSocket(`sock-${i}`, { userId: CHRIS, deviceId: did }),
    ),
  );

/** Chris est en appel avec Awa, son appareil tient la propriété. */
async function enAppel() {
  await callState.clear(CHRIS);
  await callState.clear(AWA);
  await pendingCalls.clear(CHRIS);
  callSessions._reset();
  callDeviceOwnership._reset();

  await callState.setInCall(CHRIS, { callId: ORIGIN, peerId: AWA });
  await callState.setInCall(AWA, { callId: ORIGIN, peerId: CHRIS });
  await callDeviceOwnership.setActive(String(ORIGIN), CHRIS, {
    activeDeviceId: APPAREIL,
    activeSocketId: 'sock-morte',
  });
}

(async () => {
  // ── 1. L'appareil est revenu : la grâce ne doit rien emporter ──────────────
  await enAppel();
  // La socket vivante n'est PAS celle qui tient la propriété : c'est justement
  // la situation réelle, puisque le chemin de reprise ne revendique jamais la
  // propriété — comparer les sockets ne verrait donc jamais le retour.
  let io = ioAvecAppareils([APPAREIL]);
  assert.strictEqual(
    await endActiveCallForUser(io, new Map(), CHRIS, 'disconnect_grace_expired'),
    false,
    "l'appareil de l'appel a une socket vivante : rien ne doit être retiré",
  );
  assert.strictEqual(
    (await callState.getEntry(CHRIS))?.status,
    'in_call',
    "Chris est toujours en appel : c'est tout l'objet du correctif",
  );
  assert.strictEqual(
    (await callState.getEntry(AWA))?.status,
    'in_call',
    "et son pair n'a rien vu passer",
  );

  // ── 2. Un AUTRE appareil du compte ne sauve pas l'appel ────────────────────
  await enAppel();
  io = ioAvecAppareils(['la-tablette']);
  assert.strictEqual(
    await endActiveCallForUser(io, new Map(), CHRIS, 'disconnect_grace_expired'),
    true,
    'le téléphone qui tenait l\'appel est parti : une tablette connectée ne '
      + 'doit pas maintenir un appel que plus personne ne porte',
  );

  // ── 3. Plus aucune socket : le retrait a bien lieu ─────────────────────────
  await enAppel();
  io = ioAvecAppareils([]);
  assert.strictEqual(
    await endActiveCallForUser(io, new Map(), CHRIS, 'disconnect_grace_expired'),
    true,
    'personne au bout : la grâce fait son travail',
  );
  assert.strictEqual(
    await callState.getEntry(CHRIS),
    null,
    "l'état d'appel est soldé",
  );

  // ── 4. Les délais armés APRÈS le retour gardent tout leur sens ─────────────
  for (const raison of ['resume_ack_timeout', 'resume_owner_missing']) {
    await enAppel();
    io = ioAvecAppareils([APPAREIL]);
    assert.strictEqual(
      await endActiveCallForUser(io, new Map(), CHRIS, raison),
      true,
      `${raison} : l'utilisateur est en ligne PAR CONSTRUCTION — ce délai `
        + 'existe précisément pour retirer quelqu\'un de revenu mais incapable '
        + 'de reprendre son appel. Le soumettre à la garde le viderait de son sens',
    );
  }

  console.log('✅ disconnectGraceDevice : 4 cas');
  process.exit(0);
})().catch((e) => {
  console.error('❌ disconnectGraceDevice:', e);
  process.exit(1);
});
