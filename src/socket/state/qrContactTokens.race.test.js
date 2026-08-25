/**
 * Usage unique des jetons de contact QR, contre un VRAI Redis.
 *
 * L'écran promet « une seule personne ». Le tenir suppose que la vérification
 * du jeton et sa consommation soient une seule opération : avec un `get()`
 * suivi, après l'ajout du contact en base, d'un `consume()`, deux scans
 * simultanés passaient tous deux la vérification — les deux ajouts
 * aboutissaient et le propriétaire était prévenu deux fois. Cette course
 * existait en production avant toute question de multi-instance.
 *
 * Nécessite REDIS_URL — échec explicite si absent (voir test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'qrContactTokens.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — '
    + 'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const jetons = require('./qrContactTokens');

const ITERATIONS = 100;

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);

  try {
    // ── Deux scans simultanés : un seul emporte le jeton ────────────────────
    let doubles = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const j = await jetons.create(1000 + i);
      const [a, b] = await Promise.all([jetons.claim(j.token), jetons.claim(j.token)]);
      if (a && b) doubles += 1;
      assert.ok(a || b, 'au moins un scan doit aboutir');
      await jetons.commit(j.token);
    }
    assert.strictEqual(doubles, 0, `claim : ${doubles}/${ITERATIONS} doubles consommations`);
    console.log(`✓ claim : 0/${ITERATIONS} double consommation`);

    // ── release rend bien le jeton, sans le ressusciter s'il a expiré ───────
    const rendu = await jetons.create(2001);
    assert.ok(await jetons.claim(rendu.token));
    assert.strictEqual(await jetons.get(rendu.token), null, 'réservé = indisponible');
    await jetons.release(rendu.token);
    assert.ok(await jetons.get(rendu.token), 'rendu après échec de l\'ajout');
    await jetons.commit(rendu.token);

    const disparu = await jetons.create(2002);
    await jetons.commit(disparu.token);
    await jetons.release(disparu.token);
    assert.strictEqual(
      await jetons.get(disparu.token), null,
      'release ne ressuscite pas un jeton consommé (il serait alors éternel, sans TTL)',
    );
    console.log('✓ release : rend le jeton sans jamais le ressusciter');

    // ── Garde-fou négatif : la version naïve doit échouer ───────────────────
    const naif = async (token) => {
      const cle = `alanya:qrContactTokens:${token}`;
      const pris = await client.hGet(cle, 'claimed');
      if (pris !== '0') return null;
      await new Promise((r) => setTimeout(r, 3));
      await client.hSet(cle, 'claimed', '1');
      return true;
    };
    let doublesNaifs = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const j = await jetons.create(3000 + i);
      const [a, b] = await Promise.all([naif(j.token), naif(j.token)]);
      if (a && b) doublesNaifs += 1;
      await jetons.commit(j.token);
    }
    assert.ok(
      doublesNaifs > 0,
      'garde-fou négatif : une consommation naïve devrait produire des doubles',
    );
    console.log(`✓ garde-fou négatif : la version naïve produit ${doublesNaifs}/${ITERATIONS} doubles`);

    console.log('qrContactTokens.race.test.js OK');
  } finally {
    await client.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
