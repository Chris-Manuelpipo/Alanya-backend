/**
 * Péremption et arrivée des trajets, contre un VRAI Redis.
 *
 * Deux garanties, et une mesure de coût.
 *
 * 1. **Une arrivée n'est signalée qu'une fois.** C'est la seule transition de
 *    ce store qui ne tolère pas la duplication : un second signal rouvrirait la
 *    question de l'arrivée à quelqu'un qui y a déjà répondu. La fenêtre de
 *    course est réelle — pendant une reconnexion, l'ancienne socket et la
 *    nouvelle peuvent traiter des positions pour le même trajet.
 *
 * 2. **Un silence n'est annoncé qu'une fois.** Le balayage remplace N minuteurs
 *    par un index d'échéances ; il doit rendre chaque trajet échu exactement
 *    une fois, même appelé en boucle ou depuis deux endroits.
 *
 * 3. Le coût de `armStale` est mesuré, parce que c'est ce qui a dicté la
 *    conception : cette fonction est rappelée à chaque position GPS. Si elle
 *    coûtait un aller-retour vers une base distante, le volet trajet
 *    s'effondrerait sous son propre flux.
 *
 * Nécessite REDIS_URL — échec explicite si absent (voir test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'tripState.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — '
    + 'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const tripState = require('./tripState');

const ITERATIONS = 100;
const DEST = { lat: 4.05, lng: 9.7 };
const DANS = { lat: 4.05001, lng: 9.70001, speedKmh: 2, accuracyM: 10 };
const REGLES = { radiusM: 100, hysteresisS: 60, maxSpeedKmh: 15, maxAccuracyM: 100 };

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);

  try {
    // Rejouabilité : une exécution interrompue laisse des trajets marqués
    // périmés derrière elle, et le test suivant les voit déjà traités — il
    // échoue alors sur « 0 sortie » en donnant l'impression d'une régression.
    const aNettoyer = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      for (const base of [900_000, 910_000, 920_000, 930_000]) {
        aNettoyer.push(`alanya:tripState:${base + i}`, `alanya:tripState:${base + i}:seq`);
      }
    }
    await client.del(aNettoyer);
    await client.del('alanya:tripState:echeances');

    // ── 1. Une arrivée, un seul signal ──────────────────────────────────────
    let doubles = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const trip = 900_000 + i;
      const t0 = Date.now();
      await tripState.checkArrival(trip, DANS, DEST, REGLES, t0); // pose inZoneSince
      const [a, b] = await Promise.all([
        tripState.checkArrival(trip, DANS, DEST, REGLES, t0 + 61_000),
        tripState.checkArrival(trip, DANS, DEST, REGLES, t0 + 61_000),
      ]);
      if (a && b) doubles += 1;
      assert.ok(a || b, 'l\'arrivée doit être signalée une fois');
      await tripState.clear(trip);
    }
    assert.strictEqual(doubles, 0, `arrivée : ${doubles}/${ITERATIONS} doubles signalements`);
    console.log(`✓ arrivée : 0/${ITERATIONS} double signalement`);

    // ── 2. Un silence, une seule annonce ────────────────────────────────────
    let doublesStale = 0;
    for (let i = 0; i < 40; i += 1) {
      const trip = 910_000 + i;
      await tripState.ensure(trip);
      // Échéance déjà dépassée : le balayage doit la relever au tour suivant.
      await client.zAdd('alanya:tripState:echeances', { score: Date.now() - 1, value: String(trip) });
      const [x, y] = await Promise.all([tripState.collectStale(), tripState.collectStale()]);
      const vus = [...x, ...y].filter((e) => e.tripId === trip).length;
      if (vus > 1) doublesStale += 1;
      assert.strictEqual(vus, 1, 'le trajet échu doit sortir exactement une fois');
      assert.strictEqual(await tripState.isStale(trip), true, 'marqué périmé');
      await tripState.clear(trip);
    }
    assert.strictEqual(doublesStale, 0, 'aucune double annonce de perte de signal');
    console.log('✓ péremption : 0/40 double annonce, même sur balayages concurrents');

    // Une position qui revient efface la péremption.
    const reprise = 920_000;
    await tripState.ensure(reprise);
    await client.zAdd('alanya:tripState:echeances', { score: Date.now() - 1, value: String(reprise) });
    await tripState.collectStale();
    assert.strictEqual(await tripState.isStale(reprise), true);
    await tripState.admit(reprise, { lat: 4, lng: 9 });
    assert.strictEqual(await tripState.isStale(reprise), false,
      'une position reçue lève la péremption');
    await tripState.clear(reprise);
    console.log('✓ reprise : une position reçue lève la péremption');

    // ── 3. Coût d'un réarmement — la raison d'être de la conception ─────────
    const trip = 930_000;
    await tripState.ensure(trip);
    const t0 = Date.now();
    const N = 300;
    for (let i = 0; i < N; i += 1) await tripState.armStale(trip, () => {});
    const parAppel = (Date.now() - t0) / N;
    console.log(`✓ armStale : ${parAppel.toFixed(3)} ms par réarmement (${N} appels)`);
    assert.ok(
      parAppel < 5,
      `armStale doit rester bon marché (mesuré ${parAppel.toFixed(3)} ms) : il est rappelé `
      + 'à chaque position GPS, un aller-retour vers une base distante serait rédhibitoire',
    );
    await tripState.clear(trip);

    // ── L'index ne fuit pas ─────────────────────────────────────────────────
    const restants = await client.zCard('alanya:tripState:echeances');
    assert.strictEqual(restants, 0, `index d'échéances vidé (${restants} restants)`);
    console.log('✓ index d\'échéances : vidé par clear(), aucune fuite');

    console.log('tripState.race.test.js OK');
  } finally {
    // Sans .quit(), le client resté connecté empêche ce script one-shot de finir.
    await client.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
