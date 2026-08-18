const assert = require('assert');

const {
  expiredTraceWhere,
  purgeTripPoints,
  fetchTraceRetentionStats,
} = require('./tripRetention');
const policy = require('../constants/tripPolicy');

// ── Le prédicat ─────────────────────────────────────────────────────
const echu = expiredTraceWhere();
assert.ok(echu.sql.includes('t.closed_at IS NOT NULL'));
assert.ok(echu.sql.includes('INTERVAL ? HOUR'));
assert.ok(echu.sql.includes('INTERVAL ? DAY'));
assert.deepStrictEqual(echu.params, [
  policy.RETENTION.pointsHours,
  policy.RETENTION.pointsIncidentDays,
]);

// Purge manuelle : tout trajet clos, mais JAMAIS un trajet en cours.
const force = expiredTraceWhere({ ignoreRetention: true });
assert.strictEqual(force.sql, 't.closed_at IS NOT NULL');
assert.deepStrictEqual(force.params, []);
assert.ok(!force.sql.includes('INTERVAL'));

// La rétention par défaut est bien de 30 jours.
assert.strictEqual(policy.RETENTION.pointsHours, 720);

// Le reste touche des fonctions asynchrones : Node en CommonJS n'accepte pas
// le `await` de premier niveau.
async function main() {
  // ── La purge ────────────────────────────────────────────────────────
  function recordingDb(results) {
    const calls = [];
    let i = 0;
    return {
      calls,
      execute: async (sql, params) => {
        calls.push({ sql, params: params || [] });
        return results[i++] ?? [{ affectedRows: 0 }];
      },
    };
  }

  // Le marquage doit porter sur les MÊMES trajets que la suppression : c'est le
  // bug qui faisait afficher « Trace expirée » sur des trajets encore rejouables.
  {
    const db = recordingDb([[{ affectedRows: 12 }], [{ affectedRows: 3 }]]);
    const res = await purgeTripPoints(null, {}, db);

    assert.deepStrictEqual(res, { points: 12, trips: 3 });
    assert.strictEqual(db.calls.length, 2);

    const [del, upd] = db.calls;
    assert.ok(del.sql.startsWith('DELETE p FROM trip_point'));
    assert.ok(upd.sql.includes('SET t.points_purged_at = NOW()'));
    assert.ok(upd.sql.includes('INTERVAL ? HOUR'), 'le marquage garde la rétention');
    assert.ok(upd.sql.includes('AND t.points_purged_at IS NULL'));
    assert.deepStrictEqual(upd.params, del.params, 'mêmes bornes des deux côtés');
  }

  // Restreint à un trajet : le paramètre d'id vient APRÈS les bornes, comme les
  // points d'interrogation dans le SQL.
  {
    const db = recordingDb([[{ affectedRows: 1 }], [{ affectedRows: 1 }]]);
    await purgeTripPoints(42, {}, db);
    const [del] = db.calls;
    assert.ok(del.sql.includes('AND t.id = ?'));
    assert.deepStrictEqual(del.params, [
      policy.RETENTION.pointsHours,
      policy.RETENTION.pointsIncidentDays,
      42,
    ]);
  }

  // Purge manuelle immédiate : aucune borne de temps, donc aucun paramètre.
  {
    const db = recordingDb([[{ affectedRows: 9 }], [{ affectedRows: 2 }]]);
    await purgeTripPoints(null, { ignoreRetention: true }, db);
    assert.deepStrictEqual(db.calls[0].params, []);
    assert.ok(!db.calls[0].sql.includes('INTERVAL'));
    assert.ok(db.calls[0].sql.includes('t.closed_at IS NOT NULL'));
  }

  // ── Les compteurs de l'admin ────────────────────────────────────────
  {
    const db = recordingDb([
      [[{ points: 5000, trips: 120, oldest: '2026-07-01T10:00:00.000Z' }]],
      [[{ points: 900, trips: 30 }]],
      [[{ points: 4200, trips: 100 }]],
      [[{ trips: 640 }]],
    ]);
    const stats = await fetchTraceRetentionStats(db);

    assert.strictEqual(stats.policy.pointsHours, policy.RETENTION.pointsHours);
    assert.strictEqual(stats.stored.points, 5000);
    assert.strictEqual(stats.stored.oldestPointAt, '2026-07-01T10:00:00.000Z');
    assert.strictEqual(stats.expired.trips, 30);
    assert.strictEqual(stats.closed.points, 4200);
    assert.strictEqual(stats.purgedTrips, 640);

    // Aucune identité, aucune coordonnée ne doit sortir d'ici.
    const keys = JSON.stringify(stats);
    for (const interdit of ['lat', 'lng', 'ownerId', 'owner_id', 'alanyaID', 'tripId', 'destLabel']) {
      assert.ok(!keys.includes(interdit), `champ interdit exposé : ${interdit}`);
    }
  }

  // Une base vide ne doit pas produire de NaN ni de date invalide.
  {
    const db = recordingDb([
      [[{ points: 0, trips: 0, oldest: null }]],
      [[{ points: 0, trips: 0 }]],
      [[{ points: 0, trips: 0 }]],
      [[{ trips: 0 }]],
    ]);
    const stats = await fetchTraceRetentionStats(db);
    assert.strictEqual(stats.stored.oldestPointAt, null);
    assert.strictEqual(stats.stored.points, 0);
  }


  console.log('tripRetention.test.js ✓');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
