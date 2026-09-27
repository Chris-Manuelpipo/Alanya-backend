const assert = require('assert');

const { purgeExpiredStories } = require('./dataRetentionService');

function fausseBase(lignes) {
  const appels = [];
  return {
    appels,
    execute: async (sql, params) => {
      appels.push({ sql, params });
      if (sql.startsWith('SELECT')) return [lignes];
      return [{ affectedRows: params.length }];
    },
  };
}

(async () => {
  // ── Les stories échues partent, avec leur fichier ──────────────────────
  {
    const media = 'https://www.alanya237.com/uploads/media/2026-09-01/images/media_12_1756700000000.jpg';
    const officiel = 'https://profilemedia.s3.eu-central-003.backblazeb2.com/official/images/off_1_x.jpg';
    const db = fausseBase([
      { ID: 1, mediaUrl: media },
      { ID: 2, mediaUrl: null }, // story texte
      { ID: 3, mediaUrl: officiel }, // story de diffusion
    ]);
    const passes = [];
    const res = await purgeExpiredStories({ retentionDays: 7, db, supprimerFichier: (u) => passes.push(u) });

    assert.deepStrictEqual(res, { statut: 3, fichiers: 2 });
    // Les stories de bienvenue restent exclues, et le lot reste borné.
    assert.ok(db.appels[0].sql.includes('welcome_status_delivery'));
    assert.ok(db.appels[0].sql.includes('LIMIT 5000'));
    assert.deepStrictEqual(db.appels[0].params, [7]);
    assert.ok(db.appels[1].sql.startsWith('DELETE FROM statut WHERE ID IN'));
    assert.deepStrictEqual(db.appels[1].params, [1, 2, 3]);
    // Chaque fichier est confié à `deleteMediaFile`, qui ne supprime que sous
    // `media/` : le média officiel, partagé, n'est pas touché.
    assert.deepStrictEqual(passes, [media, officiel]);
  }

  // ── Rien d'échu : aucune suppression ───────────────────────────────────
  {
    const db = fausseBase([]);
    const res = await purgeExpiredStories({ db, supprimerFichier: () => assert.fail('rien à supprimer') });
    assert.deepStrictEqual(res, { statut: 0, fichiers: 0 });
    assert.strictEqual(db.appels.length, 1);
  }

  console.log('storyPurge: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
