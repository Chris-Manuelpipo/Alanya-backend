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
const test = (nom, fn) => {
  s._reset();
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

const T0 = 1_760_000_000_000;
const pt = (lat, lng) => ({ lat, lng });

// Yaoundé, deux points distants d'environ 110 m sur l'axe nord-sud.
const A = pt(3.848000, 11.502100);
const B = pt(3.849000, 11.502100);

// --- distance ---------------------------------------------------------------

test('distanceM : ~111 m pour un millième de degré de latitude', () => {
  const d = s.distanceM(A, B);
  assert.ok(d > 100 && d < 125, `attendu ~111 m, obtenu ${d.toFixed(1)}`);
});

test('distanceM : infinie si un point manque — jamais zéro par défaut', () => {
  assert.strictEqual(s.distanceM(null, A), Infinity);
  assert.strictEqual(s.distanceM(A, null), Infinity);
});

test('distanceM : symétrique', () => {
  assert.ok(Math.abs(s.distanceM(A, B) - s.distanceM(B, A)) < 0.01);
});

// --- admit : premier point --------------------------------------------------

test('le tout premier point est toujours diffusé et persisté', () => {
  const r = s.admit(1, A, T0);
  assert.strictEqual(r.broadcast, true);
  assert.strictEqual(r.persist, true);
});

// --- admit : décimation de la diffusion ------------------------------------

test('deux points rapprochés : le second n’est pas rediffusé', () => {
  s.admit(1, A, T0);
  const r = s.admit(1, B, T0 + 1000);
  assert.strictEqual(r.broadcast, false, 'le plafond de diffusion doit tenir');
});

test('au-delà du plafond de diffusion, on rediffuse', () => {
  s.admit(1, A, T0);
  const r = s.admit(1, B, T0 + BROADCAST_MIN_S * 1000 + 1);
  assert.strictEqual(r.broadcast, true);
});

// --- admit : persistance ---------------------------------------------------

test('un trajet à l’arrêt ne remplit pas trip_point', () => {
  s.admit(1, A, T0);
  // Bien après le délai de persistance, mais sans avoir bougé : le battement
  // renvoie le même point.
  const r = s.admit(1, A, T0 + PERSIST_MIN_S * 1000 + 5000);
  assert.strictEqual(r.persist, false, 'immobile ⇒ aucune écriture');
  assert.ok(r.moved < s.MOVED_MIN_M);
});

test('un déplacement réel, après le délai, est persisté', () => {
  s.admit(1, A, T0);
  const r = s.admit(1, B, T0 + PERSIST_MIN_S * 1000 + 1);
  assert.strictEqual(r.persist, true);
});

test('un déplacement réel AVANT le délai n’est pas persisté', () => {
  s.admit(1, A, T0);
  const r = s.admit(1, B, T0 + 2000);
  assert.strictEqual(r.persist, false, 'le délai de persistance prime');
});

test('même immobile, le dernier contact est mis à jour', () => {
  s.admit(1, A, T0);
  s.admit(1, A, T0 + 60_000);
  assert.strictEqual(s.getEntry(1).lastSeenAt, T0 + 60_000,
    'c’est précisément ce qu’apporte le battement');
});

// --- déduplication ---------------------------------------------------------

test('un numéro de séquence déjà vu est détecté', () => {
  assert.strictEqual(s.isDuplicate(1, 42), false);
  s.rememberSeq(1, 42);
  assert.strictEqual(s.isDuplicate(1, 42), true);
  assert.strictEqual(s.isDuplicate(1, 43), false);
});

test('rejouer un tampon hors ligne ne crée pas de doublon', () => {
  for (const seq of [1, 2, 3]) s.rememberSeq(7, seq);
  const rejoues = [2, 3, 4].filter((q) => !s.isDuplicate(7, q));
  assert.deepStrictEqual(rejoues, [4], 'seul le point neuf doit passer');
});

test('la fenêtre de déduplication est bornée', () => {
  for (let i = 0; i < s.SEQ_WINDOW + 50; i++) s.rememberSeq(1, i);
  assert.ok(s.getEntry(1).seenSeqs.size <= s.SEQ_WINDOW,
    'la mémoire ne doit pas croître indéfiniment sur un trajet long');
  assert.strictEqual(s.isDuplicate(1, s.SEQ_WINDOW + 49), true,
    'les plus récents restent connus');
});

test('un clientSeq absent ne fait jamais passer pour un doublon', () => {
  assert.strictEqual(s.isDuplicate(1, null), false);
  assert.strictEqual(s.isDuplicate(1, undefined), false);
});

// --- péremption ------------------------------------------------------------

test('le délai de péremption suit le régime en cours', async () => {
  s.setRegime(1, 'alert');
  const court = s.armStale(1, () => {});
  s.clear(1);
  s.setRegime(1, 'nominal');
  const long = s.armStale(1, () => {});
  s.clear(1);
  assert.ok(court < long, 'en alerte, on constate le silence plus vite');
});

test('recevoir un point annule la péremption', () => {
  s.admit(1, A, T0);
  s.getEntry(1).stale = true;
  s.admit(1, B, T0 + 1000);
  assert.strictEqual(s.isStale(1), false);
});

// --- cycle de vie ----------------------------------------------------------

test('clear libère l’entrée et son timer', () => {
  s.admit(1, A, T0);
  s.armStale(1, () => {});
  assert.strictEqual(s.size(), 1);
  assert.strictEqual(s.clear(1), true);
  assert.strictEqual(s.size(), 0);
  assert.strictEqual(s.getEntry(1), null);
});

test('les trajets sont indépendants les uns des autres', () => {
  s.admit(1, A, T0);
  s.admit(2, A, T0);
  const r = s.admit(2, B, T0 + 1000);
  assert.strictEqual(r.broadcast, false);
  assert.strictEqual(s.size(), 2);
  s.clear(1);
  assert.ok(s.getEntry(2) !== null, 'clear ne doit toucher qu’un trajet');
});

test('un identifiant en chaîne désigne le même trajet qu’en nombre', () => {
  s.admit(1, A, T0);
  assert.ok(s.getEntry('1') !== null, 'la clé doit être normalisée');
});


// --- détection d'arrivée ----------------------------------------------------

const DEST = { lat: 3.849000, lng: 11.502100 };
const REGLES = { radiusM: 150, hysteresisS: 60, maxSpeedKmh: 15, maxAccuracyM: 100 };
// A est à ~111 m de DEST : dans le rayon. Un point lointain pour les contrastes.
const LOIN = pt(3.860000, 11.502100);

test('arriver demande de RESTER : le premier point dans le rayon ne suffit pas', () => {
  assert.strictEqual(s.checkArrival(1, { ...A }, DEST, REGLES, T0), false);
});

test('après l’hystérésis, l’arrivée est détectée', () => {
  s.checkArrival(1, { ...A }, DEST, REGLES, T0);
  const r = s.checkArrival(1, { ...A }, DEST, REGLES, T0 + 61_000);
  assert.strictEqual(r, true);
});

test('passer devant sans s’arrêter ne déclenche rien', () => {
  s.checkArrival(1, { ...A }, DEST, REGLES, T0);
  // On ressort de la zone : le compteur repart de zéro.
  s.checkArrival(1, { ...LOIN }, DEST, REGLES, T0 + 20_000);
  const r = s.checkArrival(1, { ...A }, DEST, REGLES, T0 + 61_000);
  assert.strictEqual(r, false, 'le faux positif numéro un doit être écarté');
});

test('rouler vite dans le rayon ne compte pas comme une arrivée', () => {
  const roule = { ...A, speedKmh: 50 };
  s.checkArrival(1, roule, DEST, REGLES, T0);
  const r = s.checkArrival(1, roule, DEST, REGLES, T0 + 61_000);
  assert.strictEqual(r, false);
});

test('un relevé trop imprécis est ignoré sans annuler l’attente en cours', () => {
  s.checkArrival(1, { ...A }, DEST, REGLES, T0);
  // Mesure floue au milieu : elle ne doit ni valider, ni remettre à zéro.
  s.checkArrival(1, { ...A, accuracyM: 400 }, DEST, REGLES, T0 + 30_000);
  const r = s.checkArrival(1, { ...A }, DEST, REGLES, T0 + 61_000);
  assert.strictEqual(r, true, 'une seule mesure floue ne doit pas tout annuler');
});

test('l’arrivée n’est signalée qu’une fois', () => {
  s.checkArrival(1, { ...A }, DEST, REGLES, T0);
  assert.strictEqual(s.checkArrival(1, { ...A }, DEST, REGLES, T0 + 61_000), true);
  assert.strictEqual(s.checkArrival(1, { ...A }, DEST, REGLES, T0 + 90_000), false);
});

test('sans destination, aucune détection', () => {
  assert.strictEqual(s.checkArrival(1, { ...A }, null, REGLES, T0), false);
  assert.strictEqual(
    s.checkArrival(1, { ...A }, { lat: null, lng: null }, REGLES, T0), false);
});

console.log(`tripState : ${ok} tests passés`);
