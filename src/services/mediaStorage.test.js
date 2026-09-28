const assert = require('assert');
const { S3Client } = require('@aws-sdk/client-s3');

const storage = require('./mediaStorage');

const CONFIG_B2 = {
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  region: 'eu-central-003',
  bucket: 'alanyaprivate',
  keyId: 'cle-test',
  appKey: 'secret-test',
};

/**
 * Vrai client S3 dont le réseau est court-circuité : chaque commande est
 * notée, et la réponse vient de `reponses`. Rien ne quitte la machine, mais
 * tout le reste du SDK — y compris `lib-storage` — tourne pour de vrai.
 */
function fauxClient(reponses = {}) {
  const appels = [];
  const client = new S3Client({
    endpoint: CONFIG_B2.endpoint,
    region: CONFIG_B2.region,
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  client.middlewareStack.add(
    (next, context) => async (args) => {
      appels.push({ commande: context.commandName, input: args.input });
      const repondre = reponses[context.commandName];
      const output = repondre ? await repondre(args.input) : {};
      return { output: { $metadata: {}, ...output }, response: {} };
    },
    { step: 'initialize', name: 'fauxReseau', priority: 'high' },
  );
  return { client, appels };
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
  storage.configureForTests(CONFIG_B2);

  await test('Backblaze disponible seulement s\'il est entièrement configuré', () => {
    assert.strictEqual(storage.isB2Enabled(), true);
    for (const manque of ['endpoint', 'region', 'bucket', 'keyId', 'appKey']) {
      storage.configureForTests({ ...CONFIG_B2, [manque]: '' });
      assert.strictEqual(storage.isB2Enabled(), false, `sans ${manque}`);
    }
    storage.configureForTests(CONFIG_B2);
  });

  await test('clés : préfixes servis seulement, aucune remontée', () => {
    assert.strictEqual(
      storage.keyFromUrl('https://www.alanya237.com/uploads/media/2026-09-15/images/a.jpg'),
      'media/2026-09-15/images/a.jpg',
    );
    assert.strictEqual(storage.keyFromUrl('https://x/uploads/images/img_1.jpg?v=2'), 'images/img_1.jpg');
    assert.strictEqual(storage.keyFromUrl('https://x/uploads/media/../../etc/passwd'), null);
    assert.strictEqual(storage.keyFromUrl('https://x/uploads/media/%2e%2e/secret'), null);
    assert.strictEqual(storage.keyFromUrl('https://x/uploads/exports/export_1.json'), null);
    assert.strictEqual(storage.keyFromUrl('https://x/autre/chemin.jpg'), null);
    assert.strictEqual(storage.keyFromPath('/media/2026-09-15/video/v.mp4'), 'media/2026-09-15/video/v.mp4');
  });

  await test('adresse héritée : la clé est recalculée dans sa partition', () => {
    // 1753000000000 ms = 2025-07-20T08:26:40Z
    assert.strictEqual(
      storage.storedKeyFromUrl('https://x/uploads/media/images/media_1_1753000000000.jpg'),
      'media/2025-07-20/images/media_1_1753000000000.jpg',
    );
    assert.strictEqual(
      storage.storedKeyFromUrl('https://x/uploads/media/2026-09-15/images/a.jpg'),
      'media/2026-09-15/images/a.jpg',
    );
  });

  await test('nouvelles clés : partition du jour UTC et suffixe aléatoire', () => {
    const t = Date.parse('2026-09-15T23:59:59Z');
    const a = storage.newMediaKey({ kind: 'video', alanyaID: 42, ext: '.mp4', instant: t });
    const b = storage.newMediaKey({ kind: 'video', alanyaID: 42, ext: '.mp4', instant: t });
    assert.match(a, /^media\/2026-09-15\/video\/media_42_\d+_[0-9a-f]{16}\.mp4$/);
    assert.notStrictEqual(a, b, 'même expéditeur, même milliseconde : deux clés différentes');
    assert.match(storage.newImageKey({ alanyaID: 7, ext: '.png' }), /^images\/img_7_\d+_[0-9a-f]{16}\.png$/);
    assert.throws(() => storage.newMediaKey({ kind: '../x', alanyaID: 1 }));
    assert.strictEqual(storage.safeExt('photo.JPG'), '.jpg');
    assert.strictEqual(storage.safeExt('x.<script>'), '');
  });

  await test("lien d'envoi : type, taille et cache font partie de la signature", async () => {
    const r = await storage.presignUpload('media/2026-09-15/video/v.mp4', {
      contentType: 'video/mp4',
      contentLength: 1234,
    });
    const u = new URL(r.url);
    assert.strictEqual(u.host, 'alanyaprivate.s3.eu-central-003.backblazeb2.com');
    const signes = u.searchParams.get('X-Amz-SignedHeaders').split(';');
    for (const h of ['content-type', 'content-length', 'cache-control', 'host']) {
      assert.ok(signes.includes(h), `${h} doit être signé`);
    }
    assert.strictEqual(u.searchParams.get('X-Amz-Expires'), String(storage.STORAGE.uploadTtlS));
    assert.deepStrictEqual(r.headers, {
      'Content-Type': 'video/mp4',
      'Cache-Control': storage.CACHE_IMMUABLE,
    });
  });

  await test('lien de lecture : signé pour la méthode demandée', async () => {
    const get = new URL(await storage.presignRead('images/a.jpg', 'GET'));
    const head = new URL(await storage.presignRead('images/a.jpg', 'HEAD'));
    assert.strictEqual(get.pathname, '/images/a.jpg');
    assert.strictEqual(get.searchParams.get('X-Amz-Expires'), String(storage.STORAGE.downloadTtlS));
    assert.notStrictEqual(
      get.searchParams.get('X-Amz-Signature'),
      head.searchParams.get('X-Amz-Signature'),
      'un lien GET ne doit pas servir à un HEAD',
    );
  });

  await test('vue unique : toutes les versions de la clé, et seulement elles', async () => {
    const { client, appels } = fauxClient({
      ListObjectVersionsCommand: () => ({
        Versions: [
          { Key: 'media/2026-09-15/images/a.jpg', VersionId: 'v1' },
          { Key: 'media/2026-09-15/images/a.jpg.bak', VersionId: 'autre' },
        ],
        DeleteMarkers: [{ Key: 'media/2026-09-15/images/a.jpg', VersionId: 'v0' }],
      }),
    });
    storage.configureForTests({ ...CONFIG_B2, client });
    assert.strictEqual(await storage.removeAllVersions('media/2026-09-15/images/a.jpg'), 2);
    const supprimees = appels
      .filter((a) => a.commande === 'DeleteObjectCommand')
      .map((a) => a.input.VersionId)
      .sort();
    assert.deepStrictEqual(supprimees, ['v0', 'v1']);
  });

  await test('liste : toutes les pages sont lues', async () => {
    let page = 0;
    const { client } = fauxClient({
      ListObjectsV2Command: (input) => {
        page += 1;
        if (page === 1) {
          return { Contents: [{ Key: 'a', Size: 1 }], IsTruncated: true, NextContinuationToken: 'p2' };
        }
        assert.strictEqual(input.ContinuationToken, 'p2');
        return { Contents: [{ Key: 'b', Size: 2 }], IsTruncated: false };
      },
    });
    storage.configureForTests({ ...CONFIG_B2, client });
    assert.deepStrictEqual(await storage.listPrefix('media/'), [
      { key: 'a', size: 1, lastModified: 0 },
      { key: 'b', size: 2, lastModified: 0 },
    ]);
  });

  await test('transfert : copie côté Backblaze vers la partition du jour', async () => {
    const { client, appels } = fauxClient();
    storage.configureForTests({ ...CONFIG_B2, client });
    const t = Date.parse('2026-09-15T10:00:00Z');
    const cle = await storage.copyForForward(
      'https://x/uploads/media/2026-09-01/images/media_1_1756700000000_aaaa.jpg',
      { alanyaID: 9, instant: t },
    );
    assert.match(cle, /^media\/2026-09-15\/images\/media_9_\d+_[0-9a-f]{16}\.jpg$/);
    const copie = appels.find((a) => a.commande === 'CopyObjectCommand');
    assert.strictEqual(copie.input.CopySource, 'alanyaprivate/media/2026-09-01/images/media_1_1756700000000_aaaa.jpg');
    assert.strictEqual(copie.input.Key, cle);
    // Un avatar n'expire pas : jamais recopié. Une URL étrangère : refusée.
    assert.strictEqual(await storage.copyForForward('https://x/uploads/images/img_1.jpg', { alanyaID: 9 }), null);
    assert.strictEqual(await storage.copyForForward('https://ailleurs/x.jpg', { alanyaID: 9 }), null);
  });

  await test('transfert : un échec Backblaze rend null, jamais une exception', async () => {
    const { client } = fauxClient({ CopyObjectCommand: () => { throw new Error('réseau'); } });
    storage.configureForTests({ ...CONFIG_B2, client });
    assert.strictEqual(
      await storage.copyForForward('https://x/uploads/media/2026-09-01/images/a.jpg', { alanyaID: 1 }),
      null,
    );
  });

  // ── Trois buckets ─────────────────────────────────────────────────────────
  const PUBLICS = {
    profile: { bucket: 'alanyaprofile', keyId: 'k-prof', appKey: 's-prof' },
    profilemedia: { bucket: 'profilemedia', keyId: 'k-pm', appKey: 's-pm' },
  };
  const SANS_PUBLICS = {
    profile: { bucket: '', keyId: '', appKey: '' },
    profilemedia: { bucket: '', keyId: '', appKey: '' },
  };
  const PROF = 'https://alanyaprofile.s3.eu-central-003.backblazeb2.com';
  const PM = 'https://profilemedia.s3.eu-central-003.backblazeb2.com';

  await test('répartition : le préfixe choisit le bucket, le privé tant que le public manque', () => {
    storage.configureForTests({ ...CONFIG_B2, publics: SANS_PUBLICS });
    assert.strictEqual(storage.cibleDe('images/img_1_2.jpg').nom, 'prive', 'pas encore configuré');
    assert.ok(storage.publicUrl('images/img_1_2.jpg').endsWith('/uploads/images/img_1_2.jpg'));

    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS });
    assert.strictEqual(storage.cibleDe('images/img_1_2.jpg').bucket, 'alanyaprofile');
    for (const key of ['voicemail/vm_1_2.m4a', 'ringtones/1/abc', 'official/images/off_1_x.jpg']) {
      assert.strictEqual(storage.cibleDe(key).bucket, 'profilemedia', key);
    }
    assert.strictEqual(storage.cibleDe('media/2026-09-01/images/a.jpg').bucket, 'alanyaprivate');
    assert.strictEqual(storage.publicUrl('images/img_1_2.jpg'), `${PROF}/images/img_1_2.jpg`);
    assert.strictEqual(storage.publicUrl('official/video/off_1_x.mp4'), `${PM}/official/video/off_1_x.mp4`);
    // Un média de discussion garde l'adresse du serveur : c'est là que se
    // décide son expiration.
    assert.ok(storage.publicUrl('media/2026-09-01/images/a.jpg').endsWith('/uploads/media/2026-09-01/images/a.jpg'));

    // Bucket public à moitié configuré : le privé.
    storage.configureForTests({ ...CONFIG_B2, publics: { profile: { appKey: '' } } });
    assert.strictEqual(storage.cibleDe('images/img_1_2.jpg').nom, 'prive');
    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS });
  });

  await test('adresse directe : relue seulement pour un préfixe de ce bucket', () => {
    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS });
    assert.strictEqual(storage.keyFromUrl(`${PROF}/images/img_1_2.jpg`), 'images/img_1_2.jpg');
    assert.strictEqual(storage.keyFromUrl(`${PM}/official/images/off_1_x.jpg?v=2`), 'official/images/off_1_x.jpg');
    assert.strictEqual(storage.keyFromUrl(`${PROF}/voicemail/vm_1.m4a`), null, 'pas le bon bucket');
    assert.strictEqual(storage.keyFromUrl(`${PROF}/media/2026-09-01/images/a.jpg`), null);
    assert.strictEqual(storage.keyFromUrl(`${PROF}/images/../.env`), null);
    assert.strictEqual(storage.keyFromUrl(`${PROF}/images/..%2F..%2F.env`), null);
    assert.strictEqual(storage.keyFromUrl('https://ailleurs.example/images/img_1.jpg'), null);
    // Les adresses du serveur restent comprises.
    assert.strictEqual(storage.keyFromUrl('https://www.alanya237.com/uploads/images/img_1_2.jpg'), 'images/img_1_2.jpg');
  });

  await test('envoi direct : signé pour le bucket du fichier, avec sa clé', async () => {
    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS });
    const photo = await storage.presignUpload('images/img_1_2.jpg', { contentType: 'image/jpeg', contentLength: 10 });
    const u = new URL(photo.url);
    assert.strictEqual(u.host, 'alanyaprofile.s3.eu-central-003.backblazeb2.com');
    assert.ok(u.searchParams.get('X-Amz-Credential').startsWith('k-prof/'), 'la clé du bucket public');
    const media = await storage.presignUpload('media/2026-09-01/images/a.jpg', { contentType: 'image/jpeg', contentLength: 10 });
    assert.strictEqual(new URL(media.url).host, 'alanyaprivate.s3.eu-central-003.backblazeb2.com');
  });

  await test('suppression d\'un fichier public : dans son bucket et dans le privé', async () => {
    const { client, appels } = fauxClient({
      ListObjectVersionsCommand: (input) => ({ Versions: [{ Key: input.Prefix, VersionId: `v-${input.Bucket}` }] }),
    });
    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS, client });
    assert.strictEqual(await storage.removeAllVersions('images/img_1_2.jpg'), 2);
    const supprimes = appels.filter((a) => a.commande === 'DeleteObjectCommand').map((a) => a.input.Bucket);
    assert.deepStrictEqual(supprimes, ['alanyaprofile', 'alanyaprivate']);

    appels.length = 0;
    await storage.removeAllVersions('media/2026-09-01/images/a.jpg');
    assert.deepStrictEqual(
      appels.filter((a) => a.commande === 'ListObjectVersionsCommand').map((a) => a.input.Bucket),
      ['alanyaprivate'],
    );
  });

  await test('copie : jamais d\'un bucket à l\'autre', async () => {
    const { client } = fauxClient();
    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS, client });
    await assert.rejects(
      storage.copyObject('media/2026-09-01/images/a.jpg', 'official/images/off_1_x.jpg'),
      /entre deux buckets/,
    );
  });

  await test('existence : 404 vaut absent, toute autre erreur remonte', async () => {
    const introuvable = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    let reponse = () => ({});
    const { client, appels } = fauxClient({ HeadObjectCommand: () => reponse() });
    storage.configureForTests({ ...CONFIG_B2, publics: PUBLICS, client });
    assert.strictEqual(await storage.headObject('ringtones/1/abc'), true);
    assert.strictEqual(appels[0].input.Bucket, 'profilemedia');
    reponse = () => { throw introuvable; };
    assert.strictEqual(await storage.headObject('ringtones/1/abc'), false);
    reponse = () => { throw new Error('réseau'); };
    await assert.rejects(storage.headObject('ringtones/1/abc'), /réseau/);
    reponse = () => ({});
    await storage.headObject('images/img_1.jpg', { depuis: 'prive' });
    assert.strictEqual(appels[appels.length - 1].input.Bucket, 'alanyaprivate');
  });

  await test('sonnerie : clé stable, imprévisible, rien sans secret', () => {
    const empreinte = 'a'.repeat(64);
    const cle = storage.ringtoneKey({ alanyaID: 12, sha256: empreinte, secret: 's1' });
    assert.match(cle, /^ringtones\/12\/[0-9a-f]{40}$/);
    assert.strictEqual(storage.ringtoneKey({ alanyaID: 12, sha256: empreinte, secret: 's1' }), cle, 'stable');
    assert.strictEqual(storage.ringtoneKey({ alanyaID: 12, sha256: empreinte.toUpperCase(), secret: 's1' }), cle);
    assert.notStrictEqual(storage.ringtoneKey({ alanyaID: 12, sha256: empreinte, secret: 's2' }), cle, 'le secret compte');
    assert.notStrictEqual(storage.ringtoneKey({ alanyaID: 13, sha256: empreinte, secret: 's1' }), cle, 'le compte compte');
    assert.ok(!cle.includes('aaaaaaaa'), "l'empreinte n'apparaît pas");
    assert.strictEqual(storage.ringtoneKey({ alanyaID: 12, sha256: empreinte, secret: '' }), null);
    assert.strictEqual(storage.ringtoneKey({ alanyaID: 12, sha256: 'pas-une-empreinte', secret: 's1' }), null);
    assert.strictEqual(storage.ringtoneKey({ alanyaID: 0, sha256: empreinte, secret: 's1' }), null);
  });

  await test('média officiel : clé non datée, hors de media/', () => {
    const cle = storage.newOfficialKey({ kind: 'images', ext: '.jpg', instant: 1756700000000 });
    assert.match(cle, /^official\/images\/off_1756700000000_[0-9a-f]{16}\.jpg$/);
    assert.ok(storage.isSafeKey(cle));
    assert.throws(() => storage.newOfficialKey({ kind: 'etc' }));
  });

  storage.configureForTests({ ...CONFIG_B2, publics: SANS_PUBLICS });
  console.log(`mediaStorage : ${ok} tests passés`);
})();
