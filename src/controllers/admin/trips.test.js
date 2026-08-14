const assert = require('assert');
const { fetchTripStats, percentile, normalizeKind, isMissingTripTable } =
  require('./trips');

// ── Helpers purs ────────────────────────────────────────────────────
assert.strictEqual(percentile([], 0.5), 0);
assert.strictEqual(percentile([10], 0.5), 10);
assert.strictEqual(percentile([1, 2, 3, 4, 5], 0.5), 3);
assert.strictEqual(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 91);

assert.strictEqual(normalizeKind('meeting'), 'walk');
assert.strictEqual(normalizeKind('walk'), 'walk');
assert.strictEqual(normalizeKind('taxi'), 'taxi');
assert.strictEqual(normalizeKind('sos'), 'sos');

assert.strictEqual(isMissingTripTable({ code: 'ER_NO_SUCH_TABLE', errno: 1146, message: "Table 'db.trip' doesn't exist" }), true);
assert.strictEqual(isMissingTripTable({ code: 'ER_BAD_FIELD_ERROR', message: 'unknown' }), false);

const FORBIDDEN = [
  'owner_id', 'ownerId', 'alanyaID', 'alanyaId',
  'dest_lat', 'destLat', 'dest_lng', 'destLng', 'dest_label', 'destLabel',
  'dest_radius_m', 'destRadiusM',
  'last_lat', 'lastLat', 'last_lng', 'lastLng', 'last_acc_m',
  'client_id', 'clientId', 'owner_device', 'ownerDevice',
  'trip_id', 'tripId', 'id',
];

function collectKeys(value, acc = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => collectKeys(v, acc));
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.push(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}

function queueDb(responses) {
  let i = 0;
  return {
    execute: async () => {
      if (i >= responses.length) throw new Error(`requête inattendue #${i}`);
      return responses[i++];
    },
  };
}

// Ordre = Promise.all dans fetchTripStats.
const SAMPLE = [
  [[{ n: 3 }]],
  [[{ started: 1284, confirmed: 1238, alerted: 31, sos: 4 }]],
  [[{ n: 1146 }]],
  [[
    { date: '2026-08-07', count: 160 },
    { date: '2026-08-08', count: 180 },
  ]],
  [[
    { k: 'taxi', n: 900 },
    { k: 'walk', n: 380 },
    { k: 'sos', n: 4 },
  ]],
  [[{ closed: 1260, avgExtensions: 0.72, alertedClosed: 31, alertsResolved: 27 }]],
  [[
    { reason: 'confirmed', n: 1200 },
    { reason: 'false_alarm', n: 20 },
    { reason: 'confirmed_after_alert', n: 7 },
    { reason: null, n: 2 },
  ]],
  [[{ sec: 600 }, { sec: 1380 }, { sec: 3060 }]],
  [[{ sec: 360 }, { sec: 360 }]],
];

(async () => {
  const data = await fetchTripStats('2026-08-07T00:00:00.000Z', '2026-08-14T23:59:59.999Z', queueDb(SAMPLE));

  assert.strictEqual(data.openNow, 3);
  assert.strictEqual(data.started, 1284);
  assert.strictEqual(data.startedPrevious, 1146);
  assert.strictEqual(data.confirmed, 1238);
  assert.strictEqual(data.confirmedRate, 96.4);
  assert.strictEqual(data.alerted, 31);
  assert.strictEqual(data.sos, 4, 'SOS kind+reason ne doit pas se doubler dans le SUM SQL mocké');
  assert.strictEqual(data.alertsClosed, 31);
  assert.strictEqual(data.alertsResolved, 27);
  assert.strictEqual(data.avgExtensions, 0.7);
  assert.strictEqual(data.startedByDay.length, 2);
  assert.strictEqual(data.startedByDay[0].date, '2026-08-07');
  assert.ok(data.byKind.some((k) => k.kind === 'taxi' && k.count === 900));
  assert.ok(data.byCloseReason.some((r) => r.reason === 'unknown' && r.count === 2));
  assert.ok(data.durationMedianSec > 0);
  assert.ok(data.period.from);
  assert.ok(data.previousPeriod.to);

  const keys = collectKeys(data);
  for (const forbidden of FORBIDDEN) {
    assert.ok(!keys.includes(forbidden), `clé interdite dans la payload : ${forbidden}`);
  }

  // Période vide → zéros, pas d'exception.
  const empty = [
    [[{ n: 0 }]],
    [[{ started: 0, confirmed: 0, alerted: 0, sos: 0 }]],
    [[{ n: 0 }]],
    [[]],
    [[]],
    [[{ closed: 0, avgExtensions: 0, alertedClosed: 0, alertsResolved: 0 }]],
    [[]],
    [[]],
    [[]],
  ];
  const zero = await fetchTripStats('2026-01-01', '2026-01-02', queueDb(empty));
  assert.strictEqual(zero.started, 0);
  assert.strictEqual(zero.confirmedRate, 0);
  assert.strictEqual(zero.durationMedianSec, 0);
  assert.strictEqual(zero.alertsResolvedMedianSec, 0);
  assert.deepStrictEqual(zero.startedByDay, []);

  console.log('admin/trips.test.js OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
