/**
 * Tests de tripPolicy — même facture que profilePrefs.test.js :
 * `node src/constants/tripPolicy.test.js`, sans framework ni base.
 *
 * On teste ce qui est PUR et décisionnel : le choix du régime, le seuil de
 * péremption, et le fait que la politique servie au client soit complète.
 */

const assert = require('assert');

// Les valeurs par défaut doivent être testées telles quelles : on nettoie
// l'environnement avant de charger le module.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('TRIP_')) delete process.env[k];
}

const policy = require('./tripPolicy');

let ok = 0;
const test = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

// --- Régimes par défaut ----------------------------------------------------

test('les défauts sont ceux du réglage réactif', () => {
  // Nominal = cadence piéton (walk) pour clients sans filterMByKind.
  assert.strictEqual(policy.REGIMES.nominal.filterM, 75);
  assert.strictEqual(policy.FILTER_M_BY_KIND.taxi, 450);
  assert.strictEqual(policy.FILTER_M_BY_KIND.walk, 75);
  assert.strictEqual(policy.REGIMES.nominal.floorS, 5);
  assert.strictEqual(policy.REGIMES.nominal.beatS, 45);
  assert.strictEqual(policy.REGIMES.approach.filterM, 15);
  assert.strictEqual(policy.REGIMES.alert.beatS, 15);
});

test('aucun régime ne demande une précision dégradée', () => {
  // `medium` chez geolocator annonce 100–500 m : une précision de quartier.
  // Le régime nominal l'avait demandée, ce qui rendait le pin inutilisable et
  // la détection d'arrivée impossible. Ce test verrouille la correction.
  for (const [nom, r] of Object.entries(policy.REGIMES)) {
    assert.ok(['balanced', 'high', 'best'].includes(r.accuracy),
      `${nom} : précision « ${r.accuracy} » non autorisée`);
    assert.notStrictEqual(r.accuracy, 'medium', `${nom} ne doit jamais être medium`);
    assert.notStrictEqual(r.accuracy, 'low', `${nom} ne doit jamais être low`);
  }
});

test('la rediffusion reste sous le seuil de perception', () => {
  // Au-delà de ~3 s, le pin saute au lieu de glisser et le suivi ne ressemble
  // plus à du temps réel.
  assert.ok(policy.BROADCAST_MIN_S <= 3,
    'la décimation de diffusion ne doit pas se voir à l’œil nu');
});

test('chaque régime a un plancher — sans lui le débit suit la vitesse', () => {
  for (const [nom, r] of Object.entries(policy.REGIMES)) {
    assert.ok(r.floorS >= 1, `${nom} : plancher manquant`);
    assert.ok(r.beatS > r.floorS, `${nom} : battement plus court que le plancher`);
  }
});

// --- Choix du régime -------------------------------------------------------

test('loin de l’échéance → nominal', () => {
  const r = policy.regimeFor({ state: 'active', msToEta: 45 * 60 * 1000 });
  assert.strictEqual(r.name, 'nominal');
});

test('nominal : taxi 450 m, à pied 75 m ; approche / alerte inchangés', () => {
  const taxi = policy.regimeFor({ state: 'active', kind: 'taxi', msToEta: 45 * 60 * 1000 });
  const walk = policy.regimeFor({ state: 'active', kind: 'walk', msToEta: 45 * 60 * 1000 });
  const meeting = policy.regimeFor({ state: 'active', kind: 'meeting', msToEta: 45 * 60 * 1000 });
  assert.strictEqual(taxi.filterM, 450);
  assert.strictEqual(walk.filterM, 75);
  assert.strictEqual(meeting.filterM, 75, 'meeting (legacy) = walk');
  const approche = policy.regimeFor({ state: 'active', kind: 'taxi', msToEta: 5 * 60 * 1000 });
  assert.strictEqual(approche.name, 'approach');
  assert.strictEqual(approche.filterM, policy.REGIMES.approach.filterM);
});

test('à moins de 10 min de l’échéance → approche', () => {
  const r = policy.regimeFor({ state: 'active', msToEta: 9 * 60 * 1000 });
  assert.strictEqual(r.name, 'approach');
});

test('à moins d’un kilomètre du but → approche, même loin dans le temps', () => {
  const r = policy.regimeFor({
    state: 'active', msToEta: 60 * 60 * 1000, distanceToDestM: 800,
  });
  assert.strictEqual(r.name, 'approach');
});

test('échéance dépassée → approche (msToEta négatif)', () => {
  const r = policy.regimeFor({ state: 'awaiting_confirm', msToEta: -120 * 1000 });
  assert.strictEqual(r.name, 'approach');
});

test('alerte et SOS → régime alerte', () => {
  assert.strictEqual(policy.regimeFor({ state: 'alert' }).name, 'alert');
  assert.strictEqual(policy.regimeFor({ state: 'sos' }).name, 'alert');
});

test('l’alerte l’emporte sur la garde batterie', () => {
  const r = policy.regimeFor({ state: 'alert', batteryPct: 3 });
  assert.strictEqual(r.name, 'alert');
  assert.strictEqual(r.beatS, policy.REGIMES.alert.beatS);
});

test('batterie faible → cadence ralentie hors alerte', () => {
  const r = policy.regimeFor({ state: 'active', msToEta: 5 * 60 * 1000, batteryPct: 11 });
  assert.strictEqual(r.name, 'nominal');
  assert.ok(r.beatS >= 120, 'le battement doit être allongé');
  assert.ok(r.floorS >= 60, 'le plancher doit être allongé');
});

test('sans contexte, on retombe sur nominal plutôt que sur une erreur', () => {
  assert.strictEqual(policy.regimeFor().name, 'nominal');
  assert.strictEqual(policy.regimeFor({ state: 'active' }).name, 'nominal');
});

// --- Péremption ------------------------------------------------------------

test('le seuil de péremption dérive du battement', () => {
  assert.strictEqual(
    policy.staleAfterSeconds('nominal'),
    policy.REGIMES.nominal.beatS * policy.STALE_FACTOR + policy.STALE_MARGIN_S,
  );
  // En alerte, on constate le silence bien plus vite.
  assert.ok(policy.staleAfterSeconds('alert') < policy.staleAfterSeconds('nominal'));
});

test('un nom de régime inconnu ne fait pas planter la détection', () => {
  assert.strictEqual(policy.staleAfterSeconds('nimportequoi'),
    policy.staleAfterSeconds('nominal'));
});

// --- États -----------------------------------------------------------------

test('les huit états du dossier sont classés, sans recouvrement', () => {
  const tous = [...policy.OPEN_STATES, ...policy.TERMINAL_STATES];
  assert.strictEqual(tous.length, 8);
  assert.strictEqual(new Set(tous).size, 8, 'un état est à la fois ouvert et terminal');
  for (const s of policy.ALERT_STATES) {
    assert.ok(policy.OPEN_STATES.has(s), `${s} doit être un état ouvert`);
  }
});

// --- Politique servie ------------------------------------------------------

test('la politique servie porte tout ce dont le client a besoin', () => {
  const p = policy.publicPolicy();
  assert.strictEqual(p.version, 1);
  for (const nom of ['nominal', 'approach', 'alert']) {
    for (const champ of ['accuracy', 'filterM', 'floorS', 'beatS']) {
      assert.ok(p.regimes[nom][champ] !== undefined, `${nom}.${champ} manquant`);
    }
  }
  assert.strictEqual(p.filterMByKind.taxi, 450);
  assert.strictEqual(p.filterMByKind.walk, 75);
  // Sans ces deux-là, le client ne sait pas quand afficher « position
  // indisponible » ni quand grisser un relevé imprécis.
  assert.ok(p.staleFactor > 0);
  assert.ok(p.maxAccuracyM > 0);
});

test('la politique servie est sérialisable telle quelle', () => {
  const p = policy.publicPolicy();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), p);
});

// --- Lecture d’environnement ----------------------------------------------

test('une valeur d’environnement absurde retombe sur le défaut', () => {
  delete require.cache[require.resolve('./tripPolicy')];
  process.env.TRIP_FILTER_M_WALK = 'beaucoup';
  process.env.TRIP_FILTER_M_TAXI = '99999';
  process.env.TRIP_BEAT_S_NOMINAL = '999999';   // au-dessus du plafond
  const p2 = require('./tripPolicy');
  assert.strictEqual(p2.FILTER_M_BY_KIND.walk, 75, 'NaN doit retomber sur le défaut');
  assert.strictEqual(p2.FILTER_M_BY_KIND.taxi, 2000, 'la valeur doit être bornée');
  assert.strictEqual(p2.REGIMES.nominal.beatS, 900, 'la valeur doit être bornée');
  delete process.env.TRIP_FILTER_M_WALK;
  delete process.env.TRIP_FILTER_M_TAXI;
  delete process.env.TRIP_BEAT_S_NOMINAL;
});

console.log(`tripPolicy : ${ok} tests passés`);
