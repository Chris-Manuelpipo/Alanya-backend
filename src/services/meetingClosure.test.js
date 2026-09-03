/**
 * Solde et balayage des réunions.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du module : on
 * observe les requêtes émises, pas leur effet.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let calls = [];
let responses = [];
const fakePool = {
  execute: async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [responses.shift() ?? [], []];
  },
  end: async () => {},
};
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakePool,
  paths: [],
  children: [],
};

const { solderMeeting, balayer, MARGE_MINUTES } = require('./meetingClosure');
const { balayable } = require('./meetingAccessRules');

async function main() {
  /* ── Solder écrit les deux côtés, jamais un seul ── */
  calls = [];
  responses = [[], []];
  await solderMeeting(7);
  assert.strictEqual(calls.length, 2, 'solder = poser isEnd ET fermer les présences');
  assert.match(calls[0].sql, /UPDATE meeting SET isEnd = 1/);
  assert.match(
    calls[1].sql,
    /UPDATE participant.*connecte = 0.*duree = GREATEST/s,
    'le second UPDATE ferme la présence et calcule la durée',
  );
  assert.match(
    calls[1].sql,
    /WHERE idMeeting = \? AND connecte = 1/,
    'seules les lignes encore ouvertes sont soldées',
  );

  /* ── Une réunion échue et vide est soldée ── */
  calls = [];
  responses = [
    [{ idMeeting: 7, isEnd: 0, connectes: 0 }], // candidates
    [], [],                                      // solderMeeting
  ];
  let n = await balayer();
  assert.strictEqual(n, 1);
  assert.ok(calls.some((c) => /UPDATE meeting SET isEnd = 1/.test(c.sql)));

  /* ── Une réunion échue mais OCCUPÉE n'est jamais soldée ── */
  // Le cœur de la décision : une réunion qui déborde de son horaire annoncé est
  // une réunion normale. La couper en pleine conversation serait un défaut bien
  // pire que celui qu'on corrige.
  calls = [];
  responses = [[{ idMeeting: 7, isEnd: 0, connectes: 1 }]];
  n = await balayer();
  assert.strictEqual(n, 0, 'un seul connecté protège la réunion');
  assert.ok(
    !calls.some((c) => /UPDATE/.test(c.sql)),
    'aucune écriture sur une réunion occupée',
  );

  /* ── Le balayage ne diffuse rien ── */
  // Un `meeting:ended` venu du balayage ferait disparaître l'écran de gens qui
  // se parlent encore. Le module n'a aucun moyen d'en émettre un : il ne reçoit
  // pas d'`io` et ne connaît pas la couche socket.
  const source = require('fs').readFileSync(require.resolve('./meetingClosure'), 'utf8');
  assert.ok(!/\bemit\s*\(/.test(source), 'aucune diffusion depuis le balayage');
  assert.ok(!/require\(.*socket/.test(source), 'le module ne connaît pas la couche socket');

  /* ── La marge est appliquée à la sélection des candidates ── */
  calls = [];
  responses = [[]];
  await balayer();
  assert.match(calls[0].sql, /INTERVAL \(m\.duree \+ \?\) MINUTE/);
  assert.deepStrictEqual(calls[0].params, [MARGE_MINUTES]);
  assert.match(
    calls[0].sql,
    /UTC_TIMESTAMP\(\)/,
    'comparaison en UTC : start_time est écrit en UTC',
  );

  /* ── La règle seule, hors de son appelant ── */
  assert.strictEqual(balayable({ isEnd: false, echue: true, connectes: 0 }), true);
  assert.strictEqual(balayable({ isEnd: false, echue: true, connectes: 1 }), false);
  assert.strictEqual(balayable({ isEnd: false, echue: false, connectes: 0 }), false);
  assert.strictEqual(balayable({ isEnd: true, echue: true, connectes: 0 }), false);

  console.log('✓ meetingClosure : solde complet, et jamais une réunion occupée');
}

main()
  .then(() => fakePool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
