const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client } = require('@aws-sdk/client-s3');

const storage = require('./mediaStorage');

const CONFIG_B2 = {
  demande: 'b2',
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

  await test('interrupteur : b2 seulement si demandé ET entièrement configuré', () => {
    assert.strictEqual(storage.isB2Enabled(), true);
    storage.configureForTests({ keyId: '' });
    assert.strictEqual(storage.isB2Enabled(), false, 'configuration incomplète : disque');
    storage.configureForTests({ ...CONFIG_B2, demande: 'disk' });
    assert.strictEqual(storage.isB2Enabled(), false);
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
      { key: 'a', size: 1 },
      { key: 'b', size: 2 },
    ]);
  });

  await test('transfert : copie côté Backblaze vers la partition du jour', async () => {
    const { client, appels } = fauxClient();
    storage.configureForTests({ ...CONFIG_B2, client });
    const racineVide = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-fwd-'));
    const t = Date.parse('2026-09-15T10:00:00Z');
    const cle = await storage.copyForForward(
      'https://x/uploads/media/2026-09-01/images/media_1_1756700000000_aaaa.jpg',
      { alanyaID: 9, instant: t, root: racineVide },
    );
    assert.match(cle, /^media\/2026-09-15\/images\/media_9_\d+_[0-9a-f]{16}\.jpg$/);
    const copie = appels.find((a) => a.commande === 'CopyObjectCommand');
    assert.strictEqual(copie.input.CopySource, 'alanyaprivate/media/2026-09-01/images/media_1_1756700000000_aaaa.jpg');
    assert.strictEqual(copie.input.Key, cle);
    // Un avatar n'expire pas : jamais recopié. Une URL étrangère : refusée.
    assert.strictEqual(await storage.copyForForward('https://x/uploads/images/img_1.jpg', { alanyaID: 9, root: racineVide }), null);
    assert.strictEqual(await storage.copyForForward('https://ailleurs/x.jpg', { alanyaID: 9, root: racineVide }), null);
    fs.rmSync(racineVide, { recursive: true });
  });

  await test('transfert pendant la transition : un fichier encore sur le disque part du disque', async () => {
    const { client, appels } = fauxClient();
    storage.configureForTests({ ...CONFIG_B2, client });
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-fwd-disque-'));
    const rel = 'media/2026-09-01/video/media_1_1756700000000.mp4';
    fs.mkdirSync(path.join(racine, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(racine, rel), Buffer.alloc(10));
    const cle = await storage.copyForForward(`https://x/uploads/${rel}`, { alanyaID: 3, root: racine });
    assert.ok(cle);
    const depot = appels.find((a) => a.commande === 'PutObjectCommand');
    assert.ok(depot, 'dépôt depuis le disque attendu');
    assert.strictEqual(depot.input.Key, cle);
    assert.strictEqual(depot.input.ContentType, 'video/mp4');
    assert.strictEqual(depot.input.CacheControl, storage.CACHE_IMMUABLE);
    assert.ok(!appels.some((a) => a.commande === 'CopyObjectCommand'));
    fs.rmSync(racine, { recursive: true });
  });

  await test('transfert : un échec Backblaze rend null, jamais une exception', async () => {
    const { client } = fauxClient({ CopyObjectCommand: () => { throw new Error('réseau'); } });
    storage.configureForTests({ ...CONFIG_B2, client });
    const racineVide = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-fwd-ko-'));
    assert.strictEqual(
      await storage.copyForForward('https://x/uploads/media/2026-09-01/images/a.jpg', { alanyaID: 1, root: racineVide }),
      null,
    );
    fs.rmSync(racineVide, { recursive: true });
  });

  console.log(`mediaStorage : ${ok} tests passés`);
})();
