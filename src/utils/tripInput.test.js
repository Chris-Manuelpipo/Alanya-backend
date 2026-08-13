/**
 * Tests de tripInput — `node src/utils/tripInput.test.js`.
 *
 * L'essentiel porte sur `resolveEta` : c'est la fonction qui garantit que
 * l'échéance appartient au serveur. Si elle laisse passer une heure fournie par
 * un client à l'horloge fausse, toute la promesse du volet s'écroule en silence.
 */

const assert = require('assert');
const t = require('./tripInput');

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

// Heure de référence fixe : les tests ne doivent pas dépendre de l'heure réelle.
const NOW = Date.UTC(2026, 7, 14, 21, 12, 0);
const MIN = 60 * 1000;

// --- clean -----------------------------------------------------------------

test('clean : vide et espaces deviennent null', () => {
  assert.strictEqual(t.clean('', 10), null);
  assert.strictEqual(t.clean('   ', 10), null);
  assert.strictEqual(t.clean(null, 10), null);
  assert.strictEqual(t.clean(undefined, 10), null);
});

test('clean : coupe à la longueur de la colonne', () => {
  assert.strictEqual(t.clean('x'.repeat(300), t.NOTE_MAX).length, t.NOTE_MAX);
  assert.strictEqual(t.clean('  taxi jaune  ', 200), 'taxi jaune');
});

// --- parseTripId -----------------------------------------------------------

test('parseTripId : refuse tout ce qui n’est pas un entier positif', () => {
  assert.strictEqual(t.parseTripId('42'), 42);
  assert.strictEqual(t.parseTripId('0'), null);
  assert.strictEqual(t.parseTripId('-3'), null);
  assert.strictEqual(t.parseTripId('abc'), null);
  assert.strictEqual(t.parseTripId(''), null);
});

// --- parseKind -------------------------------------------------------------

test('parseKind : taxi / walk ; meeting (legacy) → walk ; inconnu → taxi', () => {
  assert.strictEqual(t.parseKind('taxi'), 'taxi');
  assert.strictEqual(t.parseKind('walk'), 'walk');
  assert.strictEqual(t.parseKind('meeting'), 'walk');
  assert.strictEqual(t.parseKind('avion'), 'taxi');
  assert.strictEqual(t.parseKind(undefined), 'taxi');
});

// --- resolveEta : le chemin normal ----------------------------------------

test('durationMin : l’échéance est calculée à partir de l’horloge SERVEUR', () => {
  const r = t.resolveEta({ durationMin: 32 }, 12, NOW);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.etaAt.getTime(), NOW + 32 * MIN);
});

test('etaAt : une heure future valide est acceptée telle quelle', () => {
  const cible = new Date(NOW + 33 * MIN).toISOString();
  const r = t.resolveEta({ etaAt: cible }, 12, NOW);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.etaAt.getTime(), NOW + 33 * MIN);
});

test('durationMin l’emporte sur etaAt — il n’implique aucune horloge client', () => {
  const r = t.resolveEta(
    { durationMin: 10, etaAt: new Date(NOW + 5 * 60 * MIN).toISOString() }, 12, NOW,
  );
  assert.strictEqual(r.etaAt.getTime(), NOW + 10 * MIN);
});

// --- resolveEta : les refus ------------------------------------------------

test('aucune des deux valeurs → refus explicite', () => {
  assert.match(t.resolveEta({}, 12, NOW).error, /requis/);
  assert.match(t.resolveEta({ etaAt: '', durationMin: '' }, 12, NOW).error, /requis/);
});

test('une échéance dans le passé est refusée', () => {
  const passe = new Date(NOW - 10 * MIN).toISOString();
  assert.match(t.resolveEta({ etaAt: passe }, 12, NOW).error, /passé/);
});

test('la tolérance d’une minute absorbe une dérive bénigne', () => {
  const presque = new Date(NOW - 30 * 1000).toISOString();
  assert.ok(!t.resolveEta({ etaAt: presque }, 12, NOW).error);
});

test('le plafond de durée est appliqué aux deux formes', () => {
  assert.match(t.resolveEta({ durationMin: 13 * 60 }, 12, NOW).error, /maximale/);
  const loin = new Date(NOW + 13 * 60 * MIN).toISOString();
  assert.match(t.resolveEta({ etaAt: loin }, 12, NOW).error, /maximale/);
});

test('une durée nulle ou négative est refusée', () => {
  assert.ok(t.resolveEta({ durationMin: 0 }, 12, NOW).error);
  assert.ok(t.resolveEta({ durationMin: -5 }, 12, NOW).error);
});

test('une date illisible est refusée, pas silencieusement ignorée', () => {
  assert.match(t.resolveEta({ etaAt: 'demain matin' }, 12, NOW).error, /invalide/);
  assert.match(t.resolveEta({ durationMin: 'trente' }, 12, NOW).error, /invalide/);
});

test('un client à l’horloge fausse ne peut pas repousser l’alerte de 3 jours', () => {
  const troisJours = new Date(NOW + 3 * 24 * 60 * MIN).toISOString();
  assert.ok(t.resolveEta({ etaAt: troisJours }, 12, NOW).error,
    'le plafond de durée doit borner une horloge client trafiquée');
});

// --- toSqlDate -------------------------------------------------------------

test('toSqlDate : format DATETIME MySQL, en UTC, sans fuseau', () => {
  assert.strictEqual(t.toSqlDate(new Date(NOW)), '2026-08-14 21:12:00');
  assert.ok(!t.toSqlDate(new Date(NOW)).includes('T'));
  assert.ok(!t.toSqlDate(new Date(NOW)).includes('Z'));
});

test('toSqlDate conserve l’UTC quel que soit le fuseau du serveur', () => {
  // Une date construite en UTC doit ressortir identique : c'est ce qui garantit
  // que deux serveurs dans deux fuseaux arment la même échéance.
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.strictEqual(t.toSqlDate(d), '2026-01-01 00:00:00');
});

console.log(`tripInput : ${ok} tests passés`);
