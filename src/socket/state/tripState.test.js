/**
 * Tests de tripState — `node src/socket/state/tripState.test.js`.
 *
 * Même facture que callState.test.js : sans framework, sans base, avec une
 * horloge injectée pour ne dépendre d'aucun délai réel.
 *
 * L'essentiel porte sur `admit()` : c'est lui qui décide de rediffuser et de
 * persister. Trop laxiste, il noie le socket et remplit `trip_point` de points
 * identiques ; trop strict, la carte se fige et la trace se troue.
 */

const assert = require('assert');
const s = require('./tripState');
const { BROADCAST_MIN_S, PERSIST_MIN_S } = require('../../constants/tripPolicy');

let ok = 0;
const test = async (nom, fn) => {
  s._reset();
  try {
    await fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

(async () => {
  const T0 = 1_760_000_000_000;
  const pt = (lat, lng) => ({ lat, lng });

  // Yaoundé, deux points distants d'environ 110 m sur l'axe nord-sud.
  const A = pt(3.848000, 11.502100);
  const B = pt(3.849000, 11.502100);

  // --- distance ---------------------------------------------------------------

  await test('distanceM : ~111 m pour un millième de degré de latitude', async () => {
    const d = s.distanceM(A, B);
    assert.ok(d > 100 && d < 125, `attendu ~111 m, obtenu ${d.toFixed(1)}`);
  });

  await test('distanceM : infinie si un point manque — jamais zéro par défaut', async () => {
    assert.strictEqual(s.distanceM(null, A), Infinity);
    assert.strictEqual(s.distanceM(A, null), Infinity);
  });

  await test('distanceM : symétrique', async () => {
    assert.ok(Math.abs(s.distanceM(A, B) - s.distanceM(B, A)) < 0.01);
  });

  // --- admit : premier point --------------------------------------------------

  await test('le tout premier point est toujours diffusé et persisté', async () => {
    const r = await s.admit(1, A, T0);
    assert.strictEqual(r.broadcast, true);
    assert.strictEqual(r.persist, true);
  });

  // --- admit : décimation de la diffusion ------------------------------------

  await test('deux points rapprochés : le second n’est pas rediffusé', async () => {
    await s.admit(1, A, T0);
    const r = await s.admit(1, B, T0 + 1000);
    assert.strictEqual(r.broadcast, false, 'le plafond de diffusion doit tenir');
  });

  await test('au-delà du plafond de diffusion, on rediffuse', async () => {
    await s.admit(1, A, T0);
    const r = await s.admit(1, B, T0 + BROADCAST_MIN_S * 1000 + 1);
    assert.strictEqual(r.broadcast, true);
  });

  // --- admit : persistance ---------------------------------------------------

  await test('un trajet à l’arrêt ne remplit pas trip_point', async () => {
    await s.admit(1, A, T0);
    // Bien après le délai de persistance, mais sans avoir bougé : le battement
    // renvoie le même point.
    const r = await s.admit(1, A, T0 + PERSIST_MIN_S * 1000 + 5000);
    assert.strictEqual(r.persist, false, 'immobile ⇒ aucune écriture');
    assert.ok(r.moved < s.MOVED_MIN_M);
  });

  await test('un déplacement réel, après le délai, est persisté', async () => {
    await s.admit(1, A, T0);
    const r = await s.admit(1, B, T0 + PERSIST_MIN_S * 1000 + 1);
    assert.strictEqual(r.persist, true);
  });

  await test('un déplacement réel AVANT le délai n’est pas persisté', async () => {
    await s.admit(1, A, T0);
    const r = await s.admit(1, B, T0 + 2000);
    assert.strictEqual(r.persist, false, 'le délai de persistance prime');
  });

  await test('même immobile, le dernier contact est mis à jour', async () => {
    await s.admit(1, A, T0);
    await s.admit(1, A, T0 + 60_000);
    assert.strictEqual((await s.getEntry(1)).lastSeenAt, T0 + 60_000,
      'c’est précisément ce qu’apporte le battement');
  });

  // --- déduplication ---------------------------------------------------------

  await test('un numéro de séquence déjà vu est détecté', async () => {
    assert.strictEqual(await s.isDuplicate(1, 42), false);
    await s.rememberSeq(1, 42);
    assert.strictEqual(await s.isDuplicate(1, 42), true);
    assert.strictEqual(await s.isDuplicate(1, 43), false);
  });

  await test('rejouer un tampon hors ligne ne crée pas de doublon', async () => {
    for (const seq of [1, 2, 3]) await s.rememberSeq(7, seq);
    const rejoues = [];
    for (const q of [2, 3, 4]) if (!(await s.isDuplicate(7, q))) rejoues.push(q);
    assert.deepStrictEqual(rejoues, [4], 'seul le point neuf doit passer');
  });

  await test('la fenêtre de déduplication est bornée', async () => {
    for (let i = 0; i < s.SEQ_WINDOW + 50; i++) await s.rememberSeq(1, i);
    assert.ok((await s.getEntry(1)).seenSeqs.size <= s.SEQ_WINDOW,
      'la mémoire ne doit pas croître indéfiniment sur un trajet long');
    assert.strictEqual(await s.isDuplicate(1, s.SEQ_WINDOW + 49), true,
      'les plus récents restent connus');
  });

  await test('un clientSeq absent ne fait jamais passer pour un doublon', async () => {
    assert.strictEqual(await s.isDuplicate(1, null), false);
    assert.strictEqual(await s.isDuplicate(1, undefined), false);
  });

  // --- péremption ------------------------------------------------------------

  await test('le délai de péremption suit le régime en cours', async () => {
    await s.setRegime(1, 'alert');
    const court = await s.armStale(1, () => {});
    await s.clear(1);
    await s.setRegime(1, 'nominal');
    const long = await s.armStale(1, () => {});
    await s.clear(1);
    assert.ok(court < long, 'en alerte, on constate le silence plus vite');
  });

  await test('recevoir un point annule la péremption', async () => {
    await s.admit(1, A, T0);
    (await s.getEntry(1)).stale = true;
    await s.admit(1, B, T0 + 1000);
    assert.strictEqual(await s.isStale(1), false);
  });

  // --- cycle de vie ----------------------------------------------------------

  await test('clear libère l’entrée et son timer', async () => {
    await s.admit(1, A, T0);
    await s.armStale(1, () => {});
    assert.strictEqual(await s.size(), 1);
    assert.strictEqual(await s.clear(1), true);
    assert.strictEqual(await s.size(), 0);
    assert.strictEqual(await s.getEntry(1), null);
  });

  await test('les trajets sont indépendants les uns des autres', async () => {
    await s.admit(1, A, T0);
    await s.admit(2, A, T0);
    const r = await s.admit(2, B, T0 + 1000);
    assert.strictEqual(r.broadcast, false);
    assert.strictEqual(await s.size(), 2);
    await s.clear(1);
    assert.ok(await s.getEntry(2) !== null, 'clear ne doit toucher qu’un trajet');
  });

  await test('un identifiant en chaîne désigne le même trajet qu’en nombre', async () => {
    await s.admit(1, A, T0);
    assert.ok(await s.getEntry('1') !== null, 'la clé doit être normalisée');
  });


  // --- détection d'arrivée ----------------------------------------------------

  const DEST = { lat: 3.849000, lng: 11.502100 };
  const REGLES = { radiusM: 100, hysteresisS: 60, maxSpeedKmh: 15, maxAccuracyM: 100 };
  // DANS est à ~50 m de DEST : dans le rayon 100 m. LOIN pour les contrastes.
  const DANS = pt(3.848550, 11.502100);
  const LOIN = pt(3.860000, 11.502100);

  await test('arriver demande de RESTER : le premier point dans le rayon ne suffit pas', async () => {
    assert.strictEqual(await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0), false);
  });

  await test('après l’hystérésis, l’arrivée est détectée', async () => {
    await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0);
    const r = await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0 + 61_000);
    assert.strictEqual(r, true);
  });

  await test('passer devant sans s’arrêter ne déclenche rien', async () => {
    await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0);
    // On ressort de la zone : le compteur repart de zéro.
    await s.checkArrival(1, { ...LOIN }, DEST, REGLES, T0 + 20_000);
    const r = await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0 + 61_000);
    assert.strictEqual(r, false, 'le faux positif numéro un doit être écarté');
  });

  await test('rouler vite dans le rayon ne compte pas comme une arrivée', async () => {
    const roule = { ...DANS, speedKmh: 50 };
    await s.checkArrival(1, roule, DEST, REGLES, T0);
    const r = await s.checkArrival(1, roule, DEST, REGLES, T0 + 61_000);
    assert.strictEqual(r, false);
  });

  await test('un relevé trop imprécis est ignoré sans annuler l’attente en cours', async () => {
    await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0);
    // Mesure floue au milieu : elle ne doit ni valider, ni remettre à zéro.
    await s.checkArrival(1, { ...DANS, accuracyM: 400 }, DEST, REGLES, T0 + 30_000);
    const r = await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0 + 61_000);
    assert.strictEqual(r, true, 'une seule mesure floue ne doit pas tout annuler');
  });

  await test('l’arrivée n’est signalée qu’une fois', async () => {
    await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0);
    assert.strictEqual(await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0 + 61_000), true);
    assert.strictEqual(await s.checkArrival(1, { ...DANS }, DEST, REGLES, T0 + 90_000), false);
  });

  await test('sans destination, aucune détection', async () => {
    assert.strictEqual(await s.checkArrival(1, { ...DANS }, null, REGLES, T0), false);
    assert.strictEqual(
      await s.checkArrival(1, { ...DANS }, { lat: null, lng: null }, REGLES, T0), false);
  });

  console.log(`tripState : ${ok} tests passés`);

})().catch((e) => { console.error(e); process.exit(1); });
