const assert = require('assert');
const { mapBroadcastRow, selectPushTokens } = require('./broadcastService');

const row = {
  id: 1,
  sender_id: 10,
  created_by: 99,
  kind: 0,
  content: 'Hello',
  type: 0,
  media_url: null,
  criteria: { v: 1, op: 'and', conditions: [] },
  estimate: 100,
  client_id: 'abc',
  status: 'running',
  push_jobs_total: 10,
  push_jobs_done: 7,
  push_failed_jobs: 1,
  push_completed_at: null,
  delivered_count: 42,
  delivered_count_refreshed_at: null,
  statut_id: null,
  sent_at: new Date(),
  sender_nom: 'Alanya',
};

const mapped = mapBroadcastRow(row);
assert.strictEqual(mapped.pushProgress, 80);
assert.strictEqual(mapped.pushJobsTotal, 10);

// ── selectPushTokens ────────────────────────────────────────────────
// Le registre multi-appareils prime sur users.fcm_token.
assert.deepStrictEqual(
  selectPushTokens(
    [{ alanyaID: 1, fcm_token: 'legacy-1' }],
    new Set(),
    new Map([[1, ['dev-a', 'dev-b']]]),
  ),
  ['dev-a', 'dev-b'],
  'les appareils enregistrés remplacent le jeton historique',
);

// Repli historique quand aucun appareil n'est enregistré.
assert.deepStrictEqual(
  selectPushTokens([{ alanyaID: 2, fcm_token: 'legacy-2' }], new Set(), new Map()),
  ['legacy-2'],
);

// INDEFINI et null ne sont pas des jetons.
assert.deepStrictEqual(
  selectPushTokens(
    [{ alanyaID: 3, fcm_token: 'INDEFINI' }, { alanyaID: 4, fcm_token: null }],
    new Set(),
    new Map(),
  ),
  [],
);

// Les comptes ayant coupé les annonces sont exclus, registre compris.
assert.deepStrictEqual(
  selectPushTokens(
    [{ alanyaID: 5, fcm_token: 'legacy-5' }, { alanyaID: 6, fcm_token: 'legacy-6' }],
    new Set([5]),
    new Map([[5, ['dev-5']]]),
  ),
  ['legacy-6'],
);

// Un même jeton partagé par deux comptes n'est notifié qu'une fois.
assert.deepStrictEqual(
  selectPushTokens(
    [{ alanyaID: 7, fcm_token: 'shared' }, { alanyaID: 8, fcm_token: 'shared' }],
    new Set(),
    new Map(),
  ),
  ['shared'],
);

console.log('broadcastService.test.js OK');
