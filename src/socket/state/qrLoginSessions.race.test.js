/**
 * Atomicité des transitions de session QR contre un VRAI Redis.
 *
 * Les tests fonctionnels (qrLoginSessions.test.js) exercent le repli mémoire,
 * atomique par construction puisque JS est mono-thread : ils passeraient
 * quelle que soit l'implémentation Redis, y compris un GET-puis-SET naïf.
 * Ici, deux connexions distinctes jouent le rôle de deux instances et
 * attaquent la même session au même instant.
 *
 * Trois garanties, chacune protégeant un vrai dégât :
 *   1. `beginApproval` — deux confirmations simultanées : sans exclusivité, la
 *      seconde écrase le résultat de la première et l'appareil demandeur
 *      ouvre le compte de quelqu'un d'autre.
 *   2. `takeApproved` — deux interrogations simultanées : la paire de tokens
 *      partirait deux fois, alors que le canal est à usage unique.
 *   3. `deny` face à `approve` — un refus en vol effacerait des tokens déjà
 *      générés et déjà annoncés au client.
 *
 * Nécessite REDIS_URL — échec explicite si absent (voir test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'qrLoginSessions.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — '
    + 'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const sessions = require('./qrLoginSessions');

const ITERATIONS = 100;
const RESULTAT = { user: { alanyaID: 42 }, accessToken: 'acc', refreshToken: 'ref' };

const creer = () => sessions.create({
  deviceId: 'hw-1', deviceName: 'Pixel 8', platform: 'android', ipAddress: '10.0.0.1',
});

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);

  try {
    // ── 1. beginApproval : une seule confirmation l'emporte ─────────────────
    let doubles = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const s = await creer();
      const [a, b] = await Promise.all([
        sessions.beginApproval(s.sessionId),
        sessions.beginApproval(s.sessionId),
      ]);
      if (a && b) doubles += 1;
      await sessions.clear(s.sessionId);
    }
    assert.strictEqual(doubles, 0, `beginApproval : ${doubles}/${ITERATIONS} doubles réservations`);
    console.log(`✓ beginApproval : 0/${ITERATIONS} double réservation`);

    // ── 2. takeApproved : les tokens ne partent qu'une fois ─────────────────
    doubles = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const s = await creer();
      await sessions.beginApproval(s.sessionId);
      await sessions.approve(s.sessionId, { scannedByAlanyaID: 42, result: RESULTAT });
      const [a, b] = await Promise.all([
        sessions.takeApproved(s.sessionId),
        sessions.takeApproved(s.sessionId),
      ]);
      if (a && b) doubles += 1;
      assert.ok(a || b, 'au moins une livraison doit aboutir');
      await sessions.clear(s.sessionId);
    }
    assert.strictEqual(doubles, 0, `takeApproved : ${doubles}/${ITERATIONS} doubles livraisons`);
    console.log(`✓ takeApproved : 0/${ITERATIONS} double livraison de tokens`);

    // ── 3. deny contre approve : l'issue est cohérente, jamais mixte ────────
    // Une approbation aboutie doit conserver ses tokens ; un refus abouti ne
    // doit laisser aucun token derrière lui. Ce qu'il ne faut jamais, c'est
    // « approuvé » ET tokens effacés.
    let incoherences = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const s = await creer();
      await sessions.beginApproval(s.sessionId);
      const [approuve, refuse] = await Promise.all([
        sessions.approve(s.sessionId, { scannedByAlanyaID: 42, result: RESULTAT }),
        sessions.deny(s.sessionId),
      ]);
      const fin = await sessions.get(s.sessionId);
      if (approuve && (!fin || fin.status !== 'approved' || !fin.result)) incoherences += 1;
      if (refuse && fin && fin.result) incoherences += 1;
      await sessions.clear(s.sessionId);
    }
    assert.strictEqual(
      incoherences, 0,
      `deny/approve : ${incoherences}/${ITERATIONS} issues incohérentes`,
    );
    console.log(`✓ deny vs approve : 0/${ITERATIONS} issue incohérente`);

    // ── Garde-fou négatif ───────────────────────────────────────────────────
    // Une réservation naïve (lire le statut, puis l'écrire) doit échouer sous
    // ce même harnais — sans quoi le test ne prouverait rien.
    const naif = async (sessionId) => {
      const cle = `alanya:qrLoginSessions:${sessionId}`;
      const statut = await client.hGet(cle, 'status');
      if (statut !== 'pending' && statut !== 'scanned') return null;
      await new Promise((r) => setTimeout(r, 3));
      await client.hSet(cle, 'status', 'approving');
      return true;
    };
    let doublesNaifs = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const s = await creer();
      const [a, b] = await Promise.all([naif(s.sessionId), naif(s.sessionId)]);
      if (a && b) doublesNaifs += 1;
      await sessions.clear(s.sessionId);
    }
    assert.ok(
      doublesNaifs > 0,
      'garde-fou négatif : une réservation naïve devrait produire des doubles — '
      + 'sinon ce harnais ne détecte rien',
    );
    console.log(`✓ garde-fou négatif : la version naïve produit ${doublesNaifs}/${ITERATIONS} doubles`);

    console.log('qrLoginSessions.race.test.js OK');
  } finally {
    // Sans .quit(), le client resté connecté empêche ce script one-shot de finir.
    await client.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
