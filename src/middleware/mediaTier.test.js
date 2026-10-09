const assert = require('assert');

const MB = 1024 * 1024;
let tierBytes = 100 * MB;
const path = require.resolve('../services/billing/uploadLimits');
require.cache[path] = {
  id: path, filename: path, loaded: true,
  exports: { limitsFor: async () => ({ maxUploadBytes: tierBytes, maxAlbumItems: 30 }) },
};
const { enforceMediaTier, MULTIPART_OVERHEAD } = require('./mediaTier');

const res = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const run = async (contentLength) => {
  const req = { user: { alanyaID: 7 }, headers: contentLength == null ? {} : { 'content-length': String(contentLength) } };
  const r = res();
  let passed = false;
  await enforceMediaTier(req, r, () => { passed = true; });
  return { req, r, passed };
};

(async () => {
  // Palier standard : 100 Mo.
  let o = await run(10 * MB);
  assert.ok(o.passed);
  assert.strictEqual(o.req.mediaMaxBytes, 100 * MB, 'le contrôleur relira ce plafond contre la taille réelle');

  o = await run(100 * MB + MULTIPART_OVERHEAD);
  assert.ok(o.passed, 'un fichier de 100 Mo et ses entêtes passe');

  o = await run(120 * MB);
  assert.ok(!o.passed);
  assert.strictEqual(o.r.code, 413);
  assert.strictEqual(o.r.body.code, 'FILE_TOO_LARGE');
  assert.strictEqual(o.r.body.maxBytes, 100 * MB, 'le téléphone sait le plafond');

  // Palier payant : 200 Mo.
  tierBytes = 200 * MB;
  o = await run(150 * MB);
  assert.ok(o.passed, 'un abonné envoie 150 Mo');
  o = await run(250 * MB);
  assert.ok(!o.passed);
  assert.strictEqual(o.r.code, 413);

  // Envoi par morceaux (aucune taille annoncée) : multer et le contrôleur arrêtent.
  o = await run(null);
  assert.ok(o.passed);
  assert.strictEqual(o.req.mediaMaxBytes, 200 * MB);

  console.log('mediaTier.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
