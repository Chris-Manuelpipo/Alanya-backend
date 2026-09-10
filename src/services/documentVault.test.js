const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  vaultKey, vaultDir, vaultConfigured, seal, open, isStorageKey,
  storeDocument, readDocument, destroyDocument,
} = require('./documentVault');

const KEY = crypto.randomBytes(32);
const OTHER = crypto.randomBytes(32);

// ── Chiffrement ───────────────────────────────────────────────────────────
{
  const plain = Buffer.from('recto de la carte nationale d\'identité');
  const blob = seal(plain, KEY);
  assert.ok(blob.subarray(0, 3).equals(Buffer.from('AV1')));
  assert.ok(!blob.includes(plain), 'le clair ne doit pas apparaître');
  assert.ok(open(blob, KEY).equals(plain));
  // Deux sceaux du même clair diffèrent (IV aléatoire).
  assert.ok(!seal(plain, KEY).equals(blob));

  assert.throws(() => open(blob, OTHER), 'une autre clé ne déchiffre pas');
  const altered = Buffer.from(blob);
  altered[altered.length - 1] ^= 0xff;
  assert.throws(() => open(altered, KEY), 'un fichier altéré est refusé');
  assert.throws(() => open(Buffer.from('pas une pièce'), KEY), /format inconnu/);
}

// ── Configuration ─────────────────────────────────────────────────────────
{
  const good = KEY.toString('base64');
  assert.strictEqual(vaultKey({}), null);
  assert.ok(vaultKey({ VAULT_KEY: good }).equals(KEY));
  assert.throws(() => vaultKey({ VAULT_KEY: Buffer.alloc(16).toString('base64') }), /32 octets/);

  assert.strictEqual(vaultDir({}), null);
  assert.strictEqual(vaultDir({ VAULT_DIR: 'relatif/coffre' }), null, 'chemin absolu exigé');
  const uploads = path.resolve(__dirname, '../../uploads');
  assert.strictEqual(vaultDir({ VAULT_DIR: uploads }), null, 'jamais dans uploads/');
  assert.strictEqual(vaultDir({ VAULT_DIR: path.join(uploads, 'coffre') }), null, 'ni dessous');
  assert.strictEqual(vaultDir({ VAULT_DIR: '/var/lib/alanya/coffre' }), '/var/lib/alanya/coffre');

  assert.strictEqual(vaultConfigured({}), false);
  assert.strictEqual(vaultConfigured({ VAULT_KEY: good }), false);
  assert.strictEqual(vaultConfigured({ VAULT_KEY: 'court', VAULT_DIR: '/tmp/x' }), false);
  assert.strictEqual(vaultConfigured({ VAULT_KEY: good, VAULT_DIR: '/tmp/x' }), true);
}

// ── Clés de stockage ──────────────────────────────────────────────────────
assert.ok(isStorageKey('2026/09/0b7f6a0e-9f3c-4b8e-9c55-1f0a7f8e2d11.bin'));
for (const bad of ['../../etc/passwd', '2026/09/x.bin', '/abs/2026/09/a.bin', null, 42]) {
  assert.strictEqual(isStorageKey(bad), false, `${bad} refusée`);
}

// ── Aller-retour sur disque ───────────────────────────────────────────────
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-'));
  const env = { VAULT_KEY: KEY.toString('base64'), VAULT_DIR: dir };
  const plain = crypto.randomBytes(2048);
  const stored = await storeDocument(plain, { env, now: new Date('2026-09-22T12:00:00Z') });
  assert.ok(stored.storageKey.startsWith('2026/09/'));
  assert.strictEqual(stored.size, 2048);
  assert.strictEqual(stored.sha256, crypto.createHash('sha256').update(plain).digest('hex'));
  const onDisk = fs.readFileSync(path.join(dir, stored.storageKey));
  assert.ok(!onDisk.includes(plain.subarray(0, 64)), 'chiffré sur le disque');
  assert.ok((await readDocument(stored.storageKey, { env })).equals(plain));
  await destroyDocument(stored.storageKey, { env });
  assert.ok(!fs.existsSync(path.join(dir, stored.storageKey)));
  await destroyDocument(stored.storageKey, { env }); // déjà absente : sans erreur
  await assert.rejects(readDocument('../../etc/passwd', { env }), /invalide/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('documentVault.test.js OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
