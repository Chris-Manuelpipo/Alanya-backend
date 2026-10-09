// HEVC par discussion : la règle est dans la requête, le service la sert et
// tombe sur « H.264 » au moindre doute. La base est un double.
const assert = require('assert');
const { createVideoCodecs, BLOCKERS_SQL, ACTIVE_DAYS } = require('./videoCodecs');

const fakeDb = (impl) => {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return impl(sql, params);
    },
  };
};

(async () => {
  // ── La requête dit la règle ────────────────────────────────────────────
  assert.ok(BLOCKERS_SQL.includes('a.revoked_at IS NULL'), 'un appareil déconnecté ne compte pas');
  assert.ok(BLOCKERS_SQL.includes(`INTERVAL ${ACTIVE_DAYS} DAY`), 'un appareil oublié ne compte pas');
  assert.ok(BLOCKERS_SQL.includes('a.hevc_decode IS NULL OR a.hevc_decode = 0'),
    'une ancienne version de l’app (NULL) compte comme incapable');
  assert.ok(BLOCKERS_SQL.includes('user_presence'),
    'un membre sans ligne appareils, vu récemment, compte comme incapable');

  // ── Décision ───────────────────────────────────────────────────────────
  {
    const db = fakeDb(async () => [[{ bloquants: 0 }]]);
    const svc = createVideoCodecs({ db });
    assert.strictEqual(await svc.conversationAllowsHevc(42), true, 'aucun bloquant : HEVC');
    assert.deepStrictEqual(db.calls[0].params, [42]);
  }
  {
    const svc = createVideoCodecs({ db: fakeDb(async () => [[{ bloquants: 2 }]]) });
    assert.strictEqual(await svc.conversationAllowsHevc(42), false, 'un seul bloquant suffit');
  }
  {
    // Migration 091 pas encore appliquée : la colonne manque.
    const svc = createVideoCodecs({
      db: fakeDb(async () => { const e = new Error('Unknown column'); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }),
    });
    assert.strictEqual(await svc.conversationAllowsHevc(42), false, 'dans le doute : H.264');
  }
  {
    const svc = createVideoCodecs({ db: fakeDb(async () => [[]]) });
    assert.strictEqual(await svc.conversationAllowsHevc(42), false, 'réponse vide : H.264');
  }

  // ── Déclaration d'un appareil ─────────────────────────────────────────
  {
    const db = fakeDb(async () => [{ affectedRows: 1 }]);
    const svc = createVideoCodecs({ db });
    assert.strictEqual(await svc.recordDeviceCapabilities({ alanyaID: 7, appareilId: 3, hevcDecode: true }), true);
    assert.deepStrictEqual(db.calls[0].params, [1, 3, 7], 'la ligne de CET appareil, de CE compte');
    await svc.recordDeviceCapabilities({ alanyaID: 7, appareilId: 3, hevcDecode: false });
    assert.deepStrictEqual(db.calls[1].params, [0, 3, 7]);
  }
  {
    const db = fakeDb(async () => [{ affectedRows: 1 }]);
    const svc = createVideoCodecs({ db });
    assert.strictEqual(await svc.recordDeviceCapabilities({ alanyaID: 7, appareilId: null, hevcDecode: true }), false,
      'jeton antérieur à la migration 026 : rien à enregistrer');
    assert.strictEqual(db.calls.length, 0);
  }
  {
    const svc = createVideoCodecs({
      db: fakeDb(async () => { const e = new Error('Unknown column'); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }),
    });
    assert.strictEqual(await svc.recordDeviceCapabilities({ alanyaID: 7, appareilId: 3, hevcDecode: true }), false,
      'colonne absente : ignoré, sans erreur');
  }

  console.log('videoCodecs.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
