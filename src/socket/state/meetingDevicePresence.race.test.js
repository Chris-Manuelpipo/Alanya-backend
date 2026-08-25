/**
 * Preuve d'atomicité de meetingDevicePresence.tryJoin contre un VRAI Redis,
 * et de la revalidation par jeton de la grâce de déconnexion.
 *
 * Même logique que callDeviceOwnership.race.test.js : les tests fonctionnels
 * séquentiels (deviceIdOwnershipFoundation.test.js) passeraient tout aussi
 * bien avec un portage naïf GET+SET, puisqu'ils n'exercent jamais deux
 * appels vraiment concurrents. Garde-fou négatif inclus.
 *
 * Le second volet couvre un risque propre au portage des timers vers
 * job_queue : contrairement à clearTimeout(), un job déjà verrouillé par le
 * worker ne peut plus être annulé. Sans le jeton `graceArmedAt`, un
 * utilisateur reconnecté à la dernière seconde serait éjecté de la réunion
 * par une grâce qu'on croyait annulée.
 *
 * Nécessite REDIS_URL — échec explicite si absent (voir test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'meetingDevicePresence.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — '
    + 'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const presence = require('./meetingDevicePresence');
const { handleMeetingDisconnectGrace, setIo } = require('../../services/meetingWorkers');

// Implémentation DÉLIBÉRÉMENT naïve du claim de place, telle qu'un portage
// mécanique GET+SET (sans script Lua) la donnerait. Doit échouer ci-dessous.
async function naiveTryJoin(client, meetingId, userId, deviceId, socketId) {
  const key = `alanya:meetingDevicePresence:${meetingId}`;
  const raw = await client.hGet(key, String(userId));
  if (raw) {
    const existing = JSON.parse(raw);
    if (existing.activeDeviceId && existing.activeDeviceId !== deviceId) {
      return { ok: false, code: 'ACCOUNT_ALREADY_IN_MEETING' };
    }
  }
  // Fenêtre de course : rien n'empêche une seconde commande de lire la même
  // place « libre » avant que celle-ci n'écrive.
  await new Promise((r) => setTimeout(r, 5));
  await client.hSet(key, String(userId), JSON.stringify({
    activeDeviceId: deviceId, activeSocketId: socketId, joinedAt: Date.now(), graceArmedAt: null,
  }));
  return { ok: true };
}

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);
  setIo({ to() { return { emit() {} }; } });

  const ITERATIONS = 100;
  const U = 888777;

  try {
    // ── 1. tryJoin atomique : jamais deux gagnants ──────────────────────────
    let doubleWins = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const mid = 990000 + i;
      const [a, b] = await Promise.all([
        presence.tryJoin(mid, U, 'dev-A', 'sA'),
        presence.tryJoin(mid, U, 'dev-B', 'sB'),
      ]);
      if ((a.ok ? 1 : 0) + (b.ok ? 1 : 0) > 1) doubleWins++;
      await client.del(`alanya:meetingDevicePresence:${mid}`);
    }
    assert.strictEqual(doubleWins, 0, `tryJoin : ${doubleWins}/${ITERATIONS} double gagnant`);
    console.log(`✓ tryJoin (script Lua) : 0/${ITERATIONS} double gagnant — atomique confirmé`);

    // ── 2. Garde-fou négatif : la version naïve DOIT échouer ────────────────
    let naiveDoubleWins = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const mid = 991000 + i;
      const [a, b] = await Promise.all([
        naiveTryJoin(client, mid, U, 'dev-A', 'sA'),
        naiveTryJoin(client, mid, U, 'dev-B', 'sB'),
      ]);
      if ((a.ok ? 1 : 0) + (b.ok ? 1 : 0) > 1) naiveDoubleWins++;
      await client.del(`alanya:meetingDevicePresence:${mid}`);
    }
    assert.ok(
      naiveDoubleWins > 0,
      'garde-fou négatif : un GET+SET naïf devrait produire au moins un double gagnant — '
      + 'sinon ce harnais ne prouve rien',
    );
    console.log(`✓ garde-fou négatif : GET+SET naïf produit ${naiveDoubleWins}/${ITERATIONS} double(s) gagnant(s)`);

    // ── 3. Revalidation par jeton de la grâce ───────────────────────────────
    // runAfter volontairement lointain : job_queue est partagée avec la
    // production, qui ne connaît pas encore le kind meeting_disconnect_grace
    // tant que ce code n'est pas déployé. Un job « prêt » serait ramassé par
    // son worker et échouerait en boucle.
    const MID = 992000;
    const HEURE = 60 * 60 * 1000;

    await presence.tryJoin(MID, U, 'dev-A', 'sA');
    const tok = await presence.armDisconnectGrace(MID, U, null, HEURE);
    assert.ok(tok, 'grâce armée : jeton retourné');

    // Reconnexion avant expiration : le jeton doit être invalidé…
    await presence.tryJoin(MID, U, 'dev-A', 'sA2');
    assert.strictEqual((await presence.get(MID, U)).graceArmedAt, null, 'rejoin invalide le jeton');

    // …et la grâce en vol, même exécutée, ne doit rien faire.
    const ranStale = await handleMeetingDisconnectGrace({ meetingID: MID, userID: U, graceArmedAt: tok });
    assert.strictEqual(ranStale, false, 'jeton périmé : cascade non exécutée');
    assert.ok(await presence.get(MID, U), 'utilisateur reconnecté toujours présent');

    // Jeton courant : la cascade s'exécute normalement.
    const tok2 = await presence.armDisconnectGrace(MID, U, null, HEURE);
    const ranOk = await handleMeetingDisconnectGrace({ meetingID: MID, userID: U, graceArmedAt: tok2 });
    assert.strictEqual(ranOk, true, 'jeton courant : cascade exécutée');
    assert.strictEqual(await presence.get(MID, U), null, 'place libérée');
    console.log('✓ grâce : un rejoin invalide un job en vol (jeton graceArmedAt)');

    await presence.leave(MID, U);
    console.log('meetingDevicePresence.race.test.js OK');
  } finally {
    // Purge de la table partagée avec la prod, quoi qu'il arrive.
    const pool = require('../../config/db');
    await pool.execute("DELETE FROM job_queue WHERE dedupe_key LIKE 'meeting_presence_99%'").catch(() => {});
    await pool.end().catch(() => {});
    // Sans .quit(), le client resté connecté empêche ce script one-shot de finir.
    await client.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
