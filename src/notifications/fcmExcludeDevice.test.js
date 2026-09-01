/**
 * Qui reçoit le push `call_ended`.
 *
 * Ce fichier réimplémentait la décision au lieu de l'importer : il serait resté
 * vert quelle que soit la production, et il encodait effectivement une règle que
 * la production ne suit plus. Il teste désormais la vraie fonction.
 */
const assert = require('assert');
const { filterCallEndedTargets } = require('./callEndedTargets');

const ids = (l) => l.map((t) => t.deviceId);

const cibles = [
  { deviceId: 'B1', fcmToken: 't1' },
  { deviceId: 'B2', fcmToken: 't2' },
  { deviceId: 'INDEFINI', fcmToken: 't3' },
  { deviceId: null, fcmToken: 't4' },
];

// ── L'appareil qui vient de décrocher est épargné ─────────────────────────
assert.deepStrictEqual(
  ids(filterCallEndedTargets(cibles, 'B1')),
  ['B2'],
  'l\'exclu est écarté, et les cibles ambiguës avec lui — on ne sait pas si '
  + 'l\'une d\'elles EST l\'exclu',
);

// ── Sans exclusion, personne n'est écarté ─────────────────────────────────
assert.deepStrictEqual(
  ids(filterCallEndedTargets(cibles, null)),
  ['B1', 'B2', 'INDEFINI', null],
  'sans exclusion il n\'y a personne à épargner : écarter les cibles sans '
  + 'identifiant privait les comptes anciens de l\'ordre d\'arrêt, et leur '
  + 'téléphone sonnait jusqu\'à l\'expiration du plugin',
);

// ── Une exclusion qui ne normalise pas ne vaut pas exclusion ──────────────
assert.deepStrictEqual(
  ids(filterCallEndedTargets(cibles, 'INDEFINI')),
  ['B1', 'B2', 'INDEFINI', null],
  '`INDEFINI` ne se normalise pas : il n\'y a donc rien à exclure',
);

// ── Cas dégénérés ─────────────────────────────────────────────────────────
assert.deepStrictEqual(filterCallEndedTargets([], 'B1'), []);
assert.deepStrictEqual(filterCallEndedTargets(null, 'B1'), []);
assert.deepStrictEqual(
  ids(filterCallEndedTargets([{ deviceId: 'B1' }, null, undefined], null)),
  ['B1'],
  'une entrée vide est écartée — la laisser passer ferait lever l\'appelant '
  + 'sur `target.fcmToken`',
);

// ── L'ordre reçu est conservé ─────────────────────────────────────────────
assert.deepStrictEqual(
  ids(filterCallEndedTargets(
    [{ deviceId: 'C' }, { deviceId: 'A' }, { deviceId: 'B' }],
    null,
  )),
  ['C', 'A', 'B'],
);

console.log('fcmExcludeDevice.test.js OK');
