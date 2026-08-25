/**
 * Atomicité des sessions d'appel à trois, contre un VRAI Redis.
 *
 * Les tests fonctionnels exercent le repli mémoire, atomique d'office puisque
 * JS est mono-thread : ils passeraient quelle que soit l'implémentation Redis.
 * Ici, les opérations partent vraiment en même temps.
 *
 * Deux garanties, chacune protégeant un dégât précis :
 *   1. `openWithPending` — deux « ajouter à l'appel » simultanés sur la même
 *      paire. Sans exclusivité, chacun ouvre sa session : le droit d'ajout
 *      n'est plus unique et l'un des deux invités sonne dans le vide, sans
 *      que personne ne puisse solder son invitation.
 *   2. `registerTransferReady` — deux `call_conf_ready` simultanés. Sans
 *      garde, deux sorties automatiques sont armées et l'initiateur est
 *      retiré deux fois de l'appel.
 *
 * Nécessite REDIS_URL — échec explicite si absent (voir test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'callSessions.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — '
    + 'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const callSessions = require('./callSessions');

// L'armement d'un délai passe par job_queue, donc par MySQL distant : chaque
// itération de la section transfert coûte plusieurs allers-retours réseau. Les
// deux sections sont donc dimensionnées séparément — ce qu'on mesure est une
// exclusion mutuelle, pas un débit.
const ITERATIONS = 60;
const ITERATIONS_TRANSFERT = 20;

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);

  try {
    // ── 1. Un seul ajout par appel ──────────────────────────────────────────
    let doubles = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const A = 10_000 + i * 10;
      const B = A + 1;
      const [s1, s2] = await Promise.all([
        callSessions.openWithPending({
          originCallId: i, participants: [A, B], inviteeId: A + 2, byUserId: A,
        }),
        callSessions.openWithPending({
          originCallId: i, participants: [A, B], inviteeId: A + 3, byUserId: B,
        }),
      ]);
      if (s1 && s2) doubles += 1;
      assert.ok(s1 || s2, 'au moins un ajout doit aboutir');
      // Nettoyage direct : `destroy()` désarme aussi les délais, donc va
      // chercher MySQL — inutile ici, aucun délai n'a été armé.
      for (const s of [s1, s2]) if (s) await client.del(`alanya:callSessions:${s.sessionId}`);
      await client.del([A, B, A + 2, A + 3].map((u) => `alanya:callSessions:byUser:${u}`));
    }
    assert.strictEqual(doubles, 0, `openWithPending : ${doubles}/${ITERATIONS} doubles sessions`);
    console.log(`✓ openWithPending : 0/${ITERATIONS} double session sur la même paire`);

    // ── 2. Une seule sortie automatique armée ───────────────────────────────
    let doublesArm = 0;
    for (let i = 0; i < ITERATIONS_TRANSFERT; i += 1) {
      const A = 20_000 + i * 10;
      const B = A + 1;
      const C = A + 2;
      const s = await callSessions.openWithPending({
        originCallId: i, participants: [A, B], inviteeId: C, byUserId: A, mode: 'transfer',
      });
      await callSessions.promotePending(s.sessionId);
      await callSessions.markTransferJoined(s.sessionId, 25_000, () => {});
      const [r1, r2] = await Promise.all([
        callSessions.registerTransferReady({
          sessionId: s.sessionId, reporterId: B, peerId: C, leaveTimerMs: 10_000, onLeave: () => {},
        }),
        callSessions.registerTransferReady({
          sessionId: s.sessionId, reporterId: B, peerId: C, leaveTimerMs: 10_000, onLeave: () => {},
        }),
      ]);
      if (r1.armed && r2.armed) doublesArm += 1;
      assert.ok(r1.armed || r2.armed, 'un ready valide doit armer');
      await callSessions.destroy(s.sessionId);
    }
    assert.strictEqual(doublesArm, 0, `registerTransferReady : ${doublesArm}/${ITERATIONS_TRANSFERT} doubles armements`);
    console.log(`✓ registerTransferReady : 0/${ITERATIONS_TRANSFERT} double sortie automatique`);

    // ── Garde-fou négatif ───────────────────────────────────────────────────
    // Une ouverture naïve (vérifier les trois utilisateurs, puis écrire) doit
    // échouer sous ce même harnais.
    const naif = async (membres, invite, sessionId) => {
      for (const uid of [...membres, invite]) {
        if (await client.exists(`alanya:callSessions:byUser:${uid}`)) return null;
      }
      await new Promise((r) => setTimeout(r, 3));
      for (const uid of [...membres, invite]) {
        await client.set(`alanya:callSessions:byUser:${uid}`, sessionId);
      }
      return sessionId;
    };
    let doublesNaifs = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const A = 30_000 + i * 10;
      const B = A + 1;
      const [x, y] = await Promise.all([
        naif([A, B], A + 2, `n1_${i}`),
        naif([A, B], A + 3, `n2_${i}`),
      ]);
      if (x && y) doublesNaifs += 1;
      await client.del([A, A + 1, A + 2, A + 3].map((u) => `alanya:callSessions:byUser:${u}`));
    }
    assert.ok(
      doublesNaifs > 0,
      'garde-fou négatif : une ouverture naïve devrait produire des doubles sessions',
    );
    console.log(`✓ garde-fou négatif : la version naïve produit ${doublesNaifs}/${ITERATIONS} doubles`);

    console.log('callSessions.race.test.js OK');
  } finally {
    const pool = require('../../config/db');
    // Les délais armés pendant le test vivent dans job_queue, table partagée
    // avec la production : ne rien y laisser traîner.
    await pool.execute("DELETE FROM job_queue WHERE dedupe_key LIKE 'call_session_conf_%'").catch(() => {});
    await pool.end().catch(() => {});
    await client.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
