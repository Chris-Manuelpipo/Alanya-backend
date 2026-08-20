const assert = require('assert');

const {
  expiredMediaWhere,
  purgeExpiredMediaBatch,
  runNightlyMediaPurge,
} = require('./mediaRetention');
const policy = require('../constants/mediaRetentionPolicy');

// ── Le prédicat ─────────────────────────────────────────────────────
const echu = expiredMediaWhere();
assert.ok(echu.sql.includes('m.mediaUrl IS NOT NULL'));
assert.ok(echu.sql.includes("m.mediaUrl <> ''"));
assert.ok(echu.sql.includes('INTERVAL ? DAY'));
assert.deepStrictEqual(echu.params, [policy.RETENTION.mediaDays]);

// La rétention par défaut est bien de 30 jours.
assert.strictEqual(policy.RETENTION.mediaDays, 30);

// Une valeur d'environnement absurde ne doit pas pouvoir désactiver la purge
// ni la rendre instantanée : `readInt` borne, il n'y a jamais de NaN.
assert.ok(policy.RETENTION.mediaDays >= 1 && policy.RETENTION.mediaDays <= 365);

async function main() {
  function recordingDb(results) {
    const calls = [];
    let i = 0;
    return {
      calls,
      execute: async (sql, params) => {
        calls.push({ sql, params: params || [] });
        return results[i++] ?? [[]];
      },
    };
  }

  // Les URL de test ne correspondent à aucun fichier réel : `deleteMediaFile`
  // est best-effort et ignore l'absence, rien n'est touché sur le disque.
  const ligne = (msgID) => ({
    msgID,
    mediaUrl: `https://exemple.test/uploads/media/images/inexistant_${msgID}.jpg`,
  });

  // ── Un lot ──────────────────────────────────────────────────────────
  {
    const db = recordingDb([
      [[ligne(1), ligne(2)]],
      [{ affectedRows: 2 }],
    ]);
    const n = await purgeExpiredMediaBatch(db);
    assert.strictEqual(n, 2);
    assert.strictEqual(db.calls.length, 2);

    const [sel, upd] = db.calls;
    assert.ok(sel.sql.startsWith('SELECT msgID, mediaUrl FROM message'));
    assert.deepStrictEqual(sel.params, [policy.RETENTION.mediaDays]);

    // Le message lui-même n'est JAMAIS supprimé : seule mediaUrl est vidée.
    assert.ok(upd.sql.startsWith('UPDATE message SET mediaUrl = NULL'));
    assert.ok(!upd.sql.includes('DELETE'));
    assert.ok(!upd.sql.includes('isDeleted'));
    assert.deepStrictEqual(upd.params, [1, 2]);
  }

  // Rien d'expiré : aucune écriture, pas même un UPDATE à vide.
  {
    const db = recordingDb([[[]]]);
    const n = await purgeExpiredMediaBatch(db);
    assert.strictEqual(n, 0);
    assert.strictEqual(db.calls.length, 1, 'un SELECT seul, aucun UPDATE');
  }

  // ── La purge nocturne ───────────────────────────────────────────────
  // Elle doit vider TOUS les lots, pas seulement le premier : sinon un
  // arriéré ne se résorberait qu'à raison d'un lot par nuit.
  {
    const plein = Array.from({ length: 500 }, (_, i) => ligne(i + 1));
    const db = recordingDb([
      [plein], [{ affectedRows: 500 }],
      [plein], [{ affectedRows: 500 }],
      [[ligne(1001)]], [{ affectedRows: 1 }],
    ]);
    const res = await runNightlyMediaPurge(db);
    assert.deepStrictEqual(res, { files: 1001 });
    // 3 SELECT + 3 UPDATE : la boucle s'arrête sur le lot incomplet.
    assert.strictEqual(db.calls.length, 6);
  }

  // Base sans média expiré : la purge nocturne ne fait qu'un SELECT.
  {
    const db = recordingDb([[[]]]);
    const res = await runNightlyMediaPurge(db);
    assert.deepStrictEqual(res, { files: 0 });
    assert.strictEqual(db.calls.length, 1);
  }

  console.log('mediaRetention.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
