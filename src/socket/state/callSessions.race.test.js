/**
 * Atomicité des sessions d'appel à trois, contre un VRAI Redis.
 *
 * Les tests fonctionnels exercent le repli mémoire, atomique d'office puisque
 * JS est mono-thread : ils passeraient quelle que soit l'implémentation Redis.
 * Ici, les opérations partent vraiment en même temps.
 *
 * Cinq garanties, chacune protégeant un dégât précis :
 *   1. `openWithPending` — deux « ajouter à l'appel » simultanés sur la même
 *      paire. Sans exclusivité, chacun ouvre sa session : le droit d'ajout
 *      n'est plus unique et l'un des deux invités sonne dans le vide, sans
 *      que personne ne puisse solder son invitation.
 *   2. `registerTransferReady` — deux `call_conf_ready` simultanés. Sans
 *      garde, deux sorties automatiques sont armées et l'initiateur est
 *      retiré deux fois de l'appel.
 *   3. `addPending` — les deux restants d'une session retombée à deux
 *      appuient ensemble. Sans le verrou, deux invités sonnent pour une place.
 *   4. `addPending` contre `openWithPending` sur le même invité. Sans le
 *      `SET NX`, il appartiendrait à deux sessions à la fois.
 *   5. Le transfert en cascade. `leaveArmed`, posé par le premier transfert,
 *      doit disparaître à la greffe : sinon le `HSETNX` du second échoue et
 *      sa sortie automatique ne s'arme jamais.
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
// sections sont donc dimensionnées séparément — ce qu'on mesure est une
// exclusion mutuelle, pas un débit.
const ITERATIONS = 60;
const ITERATIONS_TRANSFERT = 12;
// 12 et non davantage : chaque itération arme puis désarme des délais via
// job_queue, donc via MySQL distant. À 20, le test frôlait les 150 s et
// échouait par dépassement de délai ou ETIMEDOUT sous charge — un échec
// d'infrastructure qui ressemble à un échec de logique. Ce qu'on mesure est
// une exclusion mutuelle : elle se voit tout aussi bien sur douze tentatives.
// La promotion désarme le délai « sans réponse » : un aller-retour MySQL par
// itération pour les sections de greffe.
const ITERATIONS_GREFFE = 20;

const cleByUser = (u) => `alanya:callSessions:byUser:${u}`;

// Awa et Chris se parlent, Chris fait entrer Nadia puis s'en va.
const retombeeADeux = async (A, B, C, originCallId) => {
  const s = await callSessions.openWithPending({
    originCallId, participants: [A, B], inviteeId: C, byUserId: A,
  });
  await callSessions.promotePending(s.sessionId);
  await callSessions.removeParticipant(s.sessionId, A);
  return s.sessionId;
};

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);

  try {
    // Le test doit être rejouable après une interruption : une exécution tuée
    // en cours laisse des clés `byUser` derrière elle, et `openWithPending`
    // refuse alors d'ouvrir la moindre session — l'échec ressemble à un bug de
    // production alors qu'il ne vient que du test précédent.
    const plages = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      for (const base of [10_000, 20_000, 30_000, 40_000, 50_000, 60_000]) {
        for (let d = 0; d < 6; d += 1) plages.push(cleByUser(base + i * 10 + d));
      }
    }
    await client.del(plages);

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
      await client.del([A, B, A + 2, A + 3].map(cleByUser));
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

    // ── 3. Une seule greffe en vol par session ──────────────────────────────
    let doublesGreffes = 0;
    for (let i = 0; i < ITERATIONS_GREFFE; i += 1) {
      const A = 40_000 + i * 10;
      const [B, C] = [A + 1, A + 2];
      const sid = await retombeeADeux(A, B, C, `g${i}`);
      const [g1, g2] = await Promise.all([
        callSessions.addPending(sid, { inviteeId: A + 3, byUserId: B }),
        callSessions.addPending(sid, { inviteeId: A + 4, byUserId: C }),
      ]);
      if (g1.session && g2.session) doublesGreffes += 1;
      assert.ok(g1.session || g2.session, `au moins une greffe doit aboutir (${g1.refus}/${g2.refus})`);
      await client.del(`alanya:callSessions:${sid}`);
      await client.del([A, B, C, A + 3, A + 4].map(cleByUser));
    }
    assert.strictEqual(doublesGreffes, 0, `addPending : ${doublesGreffes}/${ITERATIONS_GREFFE} doubles invitations`);
    console.log(`✓ addPending : 0/${ITERATIONS_GREFFE} double invitation sur la même session`);

    // ── 4. Un invité n'appartient qu'à une session ──────────────────────────
    let doublesInvite = 0;
    for (let i = 0; i < ITERATIONS_GREFFE; i += 1) {
      const A = 50_000 + i * 10;
      const [B, C, X, Y, Z] = [A + 1, A + 2, A + 3, A + 4, A + 5];
      const sid = await retombeeADeux(A, B, C, `h${i}`);
      const [g, o] = await Promise.all([
        callSessions.addPending(sid, { inviteeId: Z, byUserId: B }),
        callSessions.openWithPending({
          originCallId: `o${i}`, participants: [X, Y], inviteeId: Z, byUserId: X,
        }),
      ]);
      if (g.session && o) doublesInvite += 1;
      assert.ok(g.session || o, 'au moins une invitation doit aboutir');
      await client.del(`alanya:callSessions:${sid}`);
      if (o) await client.del(`alanya:callSessions:${o.sessionId}`);
      await client.del([A, B, C, X, Y, Z].map(cleByUser));
    }
    assert.strictEqual(doublesInvite, 0, `greffe/ouverture : ${doublesInvite}/${ITERATIONS_GREFFE} invités doublement pris`);
    console.log(`✓ addPending/openWithPending : 0/${ITERATIONS_GREFFE} invité dans deux sessions`);

    // ── 5. Le second transfert s'arme ───────────────────────────────────────
    {
      const A = 60_000;
      const [B, C, D] = [A + 1, A + 2, A + 3];
      const s = await callSessions.openWithPending({
        originCallId: 'cascade', participants: [A, B], inviteeId: C, byUserId: A, mode: 'transfer',
      });
      await callSessions.promotePending(s.sessionId);
      await callSessions.markTransferJoined(s.sessionId, 25_000, () => {});
      const premier = await callSessions.registerTransferReady({
        sessionId: s.sessionId, reporterId: B, peerId: C, leaveTimerMs: 10_000, onLeave: () => {},
      });
      assert.ok(premier.armed, `premier transfert armé (${premier.reason})`);
      await callSessions.completeTransfer(s.sessionId);
      await callSessions.removeParticipant(s.sessionId, A);

      // Nadia, entrée par le premier transfert, transfère à son tour.
      const g = await callSessions.addPending(s.sessionId, { inviteeId: D, byUserId: C, mode: 'transfer' });
      assert.ok(g.session, `greffe du second transfert (${g.refus})`);
      await callSessions.promotePending(s.sessionId);
      await callSessions.markTransferJoined(s.sessionId, 25_000, () => {});
      const second = await callSessions.registerTransferReady({
        sessionId: s.sessionId, reporterId: B, peerId: D, leaveTimerMs: 10_000, onLeave: () => {},
      });
      assert.ok(second.armed, `second transfert armé (${second.reason})`);
      await callSessions.destroy(s.sessionId);
      console.log("✓ transfert en cascade : le second transfert s'arme");
    }

    // ── Garde-fou négatif ───────────────────────────────────────────────────
    // Une ouverture naïve (vérifier les trois utilisateurs, puis écrire) doit
    // échouer sous ce même harnais.
    const naif = async (membres, invite, sessionId) => {
      for (const uid of [...membres, invite]) {
        if (await client.exists(cleByUser(uid))) return null;
      }
      await new Promise((r) => setTimeout(r, 3));
      for (const uid of [...membres, invite]) {
        await client.set(cleByUser(uid), sessionId);
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
      await client.del([A, A + 1, A + 2, A + 3].map(cleByUser));
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
