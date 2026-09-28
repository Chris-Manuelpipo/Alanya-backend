const assert = require('assert');

const reel = require('./mediaStorage');
const { executer } = require('./publicBucketsMigration');

const CONFIG_B2 = {
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  region: 'eu-central-003',
  bucket: 'alanyaprivate',
  keyId: 'cle-test',
  appKey: 'secret-test',
  publics: {
    profile: { bucket: 'alanyaprofile', keyId: 'k-prof', appKey: 's-prof' },
    profilemedia: { bucket: 'profilemedia', keyId: 'k-pm', appKey: 's-pm' },
  },
};
const HOTE = 'https://www.alanya237.com/uploads';
const PROF = 'https://alanyaprofile.s3.eu-central-003.backblazeb2.com';
const PM = 'https://profilemedia.s3.eu-central-003.backblazeb2.com';

// Le monde de départ : deux avatars et une annonce dans le bucket privé,
// l'avatar par défaut déjà copié, un média officiel rangé comme un média de
// discussion, un autre déjà expiré.

function monde() {
  return {
    prive: new Map([
      ['images/img_1_1700000000000.jpg', 'prive'],
      ['images/img_2_1700000000000.jpg', 'prive'],
      ['voicemail/vm_5_1700000000000_0123456789abcdef.m4a', 'annonce'],
      ['media/2026-08-01/images/media_9_1754000000000.jpg', 'officiel'],
    ]),
    publics: new Map([['images/default_avatar_male.png', 'defaut']]),
  };
}

const OFFICIEL = `${HOTE}/media/2026-08-01/images/media_9_1754000000000.jpg`;
const EXPIRE = `${HOTE}/media/2026-05-01/images/media_9_1746000000000.jpg`;
const OFFICIEL_NOUVEAU = `${PM}/official/images/media_9_1754000000000.jpg`;

function fauxStockage(m) {
  const ops = [];
  return {
    ops,
    storage: {
      ...reel,
      listPrefix: async (prefixe, { depuis } = {}) => [...(depuis === 'prive' ? m.prive : m.publics).keys()]
        .filter((k) => k.startsWith(prefixe))
        .map((key) => ({ key, size: 1, lastModified: 0 })),
      putBody: async (key, corps, { contentType }) => { ops.push(['privé→public', key, contentType]); m.publics.set(key, corps); },
      readPrivateObject: async (key) => {
        if (!m.prive.has(key)) throw new Error(`absent : ${key}`);
        return { Body: m.prive.get(key), ContentType: 'image/jpeg' };
      },
      headObject: async (key, { depuis } = {}) => (depuis === 'prive' ? m.prive : m.publics).has(key),
      removeAllVersions: async (key, { seulement } = {}) => {
        assert.strictEqual(seulement, 'prive', 'le nettoyage ne touche jamais aux copies');
        ops.push(['suppression privé', key]);
        m.prive.delete(key);
        return 1;
      },
    },
  };
}

function fausseBase() {
  const ecritures = [];
  const absente = Object.assign(new Error('absente'), { code: 'ER_NO_SUCH_TABLE' });
  return {
    ecritures,
    execute: async (sql, params = []) => {
      if (sql.includes('welcome_status_config')) throw absente;
      if (sql.startsWith('UPDATE')) {
        ecritures.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM users WHERE account_type')) return [[{ alanyaID: 1 }]];
      if (sql.includes('sender_id FROM broadcast')) return [[{ sender_id: 1 }]];
      if (sql.includes('FROM broadcast') || sql.includes('FROM welcome_block ')) return [[{ url: OFFICIEL }]];
      if (sql.includes('FROM welcome_status_block')) return [[]];
      if (sql.includes('FROM message')) return [[{ url: OFFICIEL }, { url: EXPIRE }]];
      if (sql.includes('FROM statut')) return [[]];
      if (sql.includes('FROM users')) {
        return [[
          { id: 1, url: `${HOTE}/images/img_1_1700000000000.jpg` },
          { id: 2, url: `http://158.220.107.211/uploads/images/img_2_1700000000000.jpg` }, // ancien hôte
          { id: 3, url: `${HOTE}/images/default_avatar_male.png` }, // déjà copié
          { id: 4, url: `${HOTE}/images/img_4_1700000000000.jpg` }, // fichier perdu
          { id: 6, url: 'https://lh3.googleusercontent.com/a/photo.jpg' }, // ailleurs
        ]];
      }
      if (sql.includes('FROM conversation')) return [[]];
      if (sql.includes('FROM user_voicemail_schedule')) {
        return [[{ id: 5, url: `${HOTE}/voicemail/vm_5_1700000000000_0123456789abcdef.m4a` }]];
      }
      throw new Error(`requête inattendue : ${sql}`);
    },
  };
}

(async () => {
  reel.configureForTests(CONFIG_B2);
  const silence = () => {};

  // ── Simulation : tout est compté, rien n'est écrit ──────────────────────
  {
    const m = monde();
    const { storage, ops } = fauxStockage(m);
    const db = fausseBase();
    const res = await executer({ db, storage, log: silence });
    assert.strictEqual(ops.length, 0, 'aucune copie');
    assert.strictEqual(db.ecritures.length, 0, 'aucune écriture en base');
    assert.deepStrictEqual(res.copie, { dejaLa: 0, aCopier: 3, copies: 0, echecs: 0 });
    assert.strictEqual(res.officiels.adresses, 1);
    assert.strictEqual(res.officiels.introuvables, 1);
    assert.deepStrictEqual(res.adresses, { aReecrire: 4, reecrites: 0, fichierAbsent: 1 });
  }

  // ── Application ─────────────────────────────────────────────────────────
  const m = monde();
  const { storage, ops } = fauxStockage(m);
  {
    const db = fausseBase();
    const res = await executer({ appliquer: true, db, storage, log: silence });
    assert.deepStrictEqual(ops.map((o) => o.slice(0, 2)).sort(), [
      ['privé→public', 'images/img_1_1700000000000.jpg'],
      ['privé→public', 'images/img_2_1700000000000.jpg'],
      ['privé→public', 'official/images/media_9_1754000000000.jpg'],
      ['privé→public', 'voicemail/vm_5_1700000000000_0123456789abcdef.m4a'],
    ]);
    assert.strictEqual(res.copie.copies, 3);
    assert.strictEqual(res.officiels.copies, 1);

    // Médias officiels : réécrits partout, l'expiré laissé tel quel.
    const officielles = db.ecritures.filter((e) => e.params[0] === OFFICIEL_NOUVEAU);
    const tables = officielles.map((e) => e.sql.split(' ')[1]);
    assert.deepStrictEqual(tables, ['broadcast', 'welcome_block', 'welcome_status_block', 'message', 'statut']);
    assert.ok(officielles.every((e) => e.params[e.params.length - 1] === OFFICIEL));
    assert.ok(!db.ecritures.some((e) => e.params.includes(EXPIRE)));
    // Les messages du compte officiel seulement.
    assert.ok(officielles.find((e) => e.sql.startsWith('UPDATE message')).sql.includes('senderID IN (?)'));

    // Adresses : par clé primaire, vers le bucket public du fichier.
    const adresses = db.ecritures.filter((e) => e.params[0] !== OFFICIEL_NOUVEAU);
    assert.deepStrictEqual(adresses.map((e) => [e.sql.split(' ')[1], e.params[0], e.params[1]]), [
      ['users', `${PROF}/images/img_1_1700000000000.jpg`, 1],
      ['users', `${PROF}/images/img_2_1700000000000.jpg`, 2],
      ['users', `${PROF}/images/default_avatar_male.png`, 3],
      ['user_voicemail_schedule', `${PM}/voicemail/vm_5_1700000000000_0123456789abcdef.m4a`, 5],
    ]);
    assert.ok(adresses.every((e) => / AND \w+ = \?$/.test(e.sql.trim())), "seulement si la ligne n'a pas changé");
    assert.strictEqual(res.adresses.fichierAbsent, 1, 'fichier perdu : adresse gardée');
  }

  // ── Seconde exécution : rien n'est recopié ──────────────────────────────
  {
    ops.length = 0;
    const res = await executer({ appliquer: true, db: fausseBase(), storage, log: silence });
    assert.strictEqual(ops.length, 0);
    assert.strictEqual(res.copie.dejaLa, 3);
    assert.strictEqual(res.officiels.copies, 0);
  }

  // ── Nettoyage : seulement ce qui a une copie publique ───────────────────
  {
    ops.length = 0;
    const res = await executer({ appliquer: true, nettoyer: true, db: fausseBase(), storage, log: silence });
    assert.deepStrictEqual(ops.map((o) => o[1]).sort(), [
      'images/img_1_1700000000000.jpg',
      'images/img_2_1700000000000.jpg',
      'voicemail/vm_5_1700000000000_0123456789abcdef.m4a',
    ]);
    assert.ok(m.prive.has('media/2026-08-01/images/media_9_1754000000000.jpg'), 'les médias de discussion restent');
    assert.deepStrictEqual(res.nettoyage, { aSupprimer: 3, supprimes: 3, gardes: 0 });
  }

  // ── Buckets publics non configurés : refus avant toute lecture ──────────
  {
    reel.configureForTests({ ...CONFIG_B2, publics: { profile: { bucket: '' } } });
    const { storage: s2 } = fauxStockage(monde());
    await assert.rejects(executer({ db: fausseBase(), storage: s2, log: silence }), /non configurés/);
  }

  reel.configureForTests({
    ...CONFIG_B2,
    publics: {
      profile: { bucket: '', keyId: '', appKey: '' },
      profilemedia: { bucket: '', keyId: '', appKey: '' },
    },
  });
  console.log('publicBucketsMigration: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
