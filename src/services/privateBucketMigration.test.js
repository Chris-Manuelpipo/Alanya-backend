const assert = require('assert');

const { executer } = require('./privateBucketMigration');

// Le monde de départ : trois médias chez Backblaze, dont un déjà copié chez R2
// et un copié à moitié (taille différente). R2 a aussi un média né après la
// bascule, que la copie ne doit pas toucher.
function monde() {
  return {
    ancien: new Map([
      ['media/2026-10-01/images/a.jpg', 'aaaa'],
      ['media/2026-10-02/video/b.mp4', 'bbbbbbbb'],
      ['media/2026-10-03/audio/c.m4a', 'cc'],
    ]),
    prive: new Map([
      ['media/2026-10-01/images/a.jpg', 'aaaa'],
      ['media/2026-10-02/video/b.mp4', 'bbb'],
      ['media/2026-10-10/images/nouveau.jpg', 'n'],
    ]),
  };
}

function fauxStockage(m, { etat = { r2: true, ancien: true, terminee: false }, illisibles = [] } = {}) {
  const ecrits = [];
  return {
    ecrits,
    storage: {
      etatMigrationPrivee: () => etat,
      listPrefix: async (prefixe, { depuis }) => [...m[depuis].entries()]
        .filter(([k]) => k.startsWith(prefixe))
        .map(([key, corps]) => ({ key, size: corps.length, lastModified: 0 })),
      readPrivateObject: async (key, { depuis }) => {
        assert.strictEqual(depuis, 'ancien', 'on ne lit que l\'ancien bucket');
        if (illisibles.includes(key)) throw new Error('réseau');
        return { Body: m.ancien.get(key), ContentType: 'image/jpeg' };
      },
      putBody: async (key, corps, { contentType }) => {
        ecrits.push([key, contentType]);
        m.prive.set(key, corps);
      },
    },
  };
}

let ok = 0;
const test = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.stack}`);
    process.exitCode = 1;
  }
};

(async () => {
  await test('simulation : compte ce qui manque, n\'écrit rien', async () => {
    const m = monde();
    const { storage, ecrits } = fauxStockage(m);
    const r = await executer({ storage, log: () => {} });
    assert.deepStrictEqual(r, { sources: 3, dejaLa: 1, aCopier: 2, octets: 10, copies: 0, echecs: 0, manquants: 0 });
    assert.strictEqual(ecrits.length, 0);
  });

  await test('application : copie ce qui manque ou diffère, sous la même clé', async () => {
    const m = monde();
    const { storage, ecrits } = fauxStockage(m);
    const r = await executer({ appliquer: true, storage, log: () => {} });
    assert.deepStrictEqual(r, { sources: 3, dejaLa: 1, aCopier: 2, octets: 10, copies: 2, echecs: 0, manquants: 0 });
    assert.deepStrictEqual(ecrits, [
      ['media/2026-10-02/video/b.mp4', 'image/jpeg'],
      ['media/2026-10-03/audio/c.m4a', 'image/jpeg'],
    ]);
    assert.strictEqual(m.prive.get('media/2026-10-02/video/b.mp4'), 'bbbbbbbb');
    assert.strictEqual(m.prive.get('media/2026-10-10/images/nouveau.jpg'), 'n', 'un média né chez R2 reste intact');
    assert.strictEqual(m.ancien.size, 3, 'rien n\'est supprimé chez Backblaze');

    // Rejouable : plus rien à faire.
    const encore = await executer({ appliquer: true, storage, log: () => {} });
    assert.deepStrictEqual(encore, { sources: 3, dejaLa: 3, aCopier: 0, octets: 0, copies: 0, echecs: 0, manquants: 0 });
  });

  await test('un échec est compté, signalé comme manquant, et n\'arrête pas la copie', async () => {
    const m = monde();
    const journal = [];
    const { storage } = fauxStockage(m, { illisibles: ['media/2026-10-02/video/b.mp4'] });
    const r = await executer({ appliquer: true, storage, log: (l) => journal.push(l) });
    assert.strictEqual(r.copies, 1);
    assert.strictEqual(r.echecs, 1);
    assert.strictEqual(r.manquants, 1);
    assert.ok(journal[0].includes('media/2026-10-02/video/b.mp4'));
  });

  await test('refuse de partir sans les deux buckets', async () => {
    for (const etat of [{ r2: false, ancien: true }, { r2: true, ancien: false }]) {
      const { storage } = fauxStockage(monde(), { etat });
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(executer({ storage }), /deux buckets privés/);
    }
  });

  console.log(`privateBucketMigration : ${ok} tests passés`);
})();
