/**
 * Suppression de compte et export — données stickers (type 10).
 * `node src/services/accountDeletionStickers.test.js`.
 *
 * T8a : `user_sticker_pack`, `user_sticker_favorite` et `sticker_report`
 * (rapporteur) partent avec le compte, ainsi que le contenu privé (packs et
 * actifs dont le compte est propriétaire) ; l'officiel n'est jamais visé.
 * L'export de données inclut ces lignes (plan §4). Contrôle par un
 * `../config/db` doublé — même patron que `stickerRoutes.test.js`.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

let ok = 0;
const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

(async () => {
  const requetes = [];
  const conn = {
    execute: async (sql, p) => { requetes.push([sql, p]); return [[], []]; },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => { throw new Error('rollback inattendu'); },
    release: () => {},
  };
  const pool = {
    execute: async (sql, p) => {
      requetes.push([sql, p]);
      if (/SELECT alanyaID FROM users/i.test(sql)) return [[{ alanyaID: 42 }], []];
      return [[], []];
    },
    getConnection: async () => conn,
  };
  remplace('../config/db', pool);
  const svc = require('./accountDeletionService');

  const trouve = (re) => requetes.find(([sql]) => re.test(sql));

  test('la purge supprime les données stickers du compte', async () => {
    requetes.length = 0;
    await svc.purgeExpiredAccounts();

    const packs = trouve(/DELETE FROM user_sticker_pack WHERE alanyaID/i);
    const favoris = trouve(/DELETE FROM user_sticker_favorite WHERE alanyaID/i);
    const signalements = trouve(/DELETE FROM sticker_report WHERE reporter_id/i);
    const packsPrives = trouve(/DELETE FROM sticker_pack WHERE owner_id/i);
    const actifsPrives = trouve(/DELETE FROM sticker_asset WHERE owner_id/i);

    assert.ok(packs, 'packs installés non supprimés');
    assert.ok(favoris, 'favoris non supprimés');
    assert.ok(signalements, 'signalements du rapporteur non supprimés');
    assert.ok(packsPrives, 'packs privés non supprimés');
    assert.ok(actifsPrives, 'actifs privés non supprimés');
    // L'officiel (owner_id = 0) n'est jamais visé : le paramètre est le compte.
    assert.deepStrictEqual(actifsPrives[1], [42]);
    assert.deepStrictEqual(packsPrives[1], [42]);
  });

  test("table absente (migration 097 non jouée) : la purge n'échoue pas", async () => {
    requetes.length = 0;
    const errConn = {
      execute: async (sql, p) => {
        requetes.push([sql, p]);
        if (/user_sticker_pack|user_sticker_favorite|sticker_report|sticker_pack|sticker_asset/i.test(sql)) {
          const e = new Error('table inconnue');
          e.code = 'ER_NO_SUCH_TABLE';
          throw e;
        }
        return [[], []];
      },
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => { throw new Error('rollback inattendu'); },
      release: () => {},
    };
    pool.getConnection = async () => errConn;
    try {
      await svc.purgeExpiredAccounts();
    } finally {
      pool.getConnection = async () => conn;
    }
    assert.ok(trouve(/DELETE FROM users WHERE alanyaID/i), 'la suppression du compte continue');
  });

  test("l'export inclut les packs installés et les favoris", async () => {
    const db = {
      execute: async (sql) => {
        if (/FROM user_sticker_pack/i.test(sql)) {
          return [[{ pack_id: 3, code: 'mboa', position: 0, added_at: new Date() }], []];
        }
        if (/FROM user_sticker_favorite/i.test(sql)) {
          return [[{ sticker_id: 9, added_at: new Date() }], []];
        }
        return [[], []];
      },
    };
    const { chargeStickersExport } = require('./stickerStore');
    const r = await chargeStickersExport(42, db);
    assert.strictEqual(r.installedPacks.length, 1);
    assert.strictEqual(r.installedPacks[0].code, 'mboa');
    assert.strictEqual(r.favorites.length, 1);
    assert.strictEqual(r.favorites[0].sticker_id, 9);
  });

  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`accountDeletionStickers.test.js : ${ok} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
