// Le ticket d'envoi direct applique le plafond du palier du compte : 50 Mo, et
// 200 Mo pour qui a payé. Stockage et plafonds sont des doubles : on éprouve la
// décision du contrôleur, pas Backblaze.
const assert = require('assert');

const MB = 1024 * 1024;
let tierBytes = 50 * MB;

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/mediaStorage', {
  isB2Enabled: () => true,
  safeExt: () => '.mp4',
  newMediaKey: () => 'media/video/2026-10-03/x.mp4',
  newImageKey: () => 'avatars/x.jpg',
  presignUpload: async () => ({ url: 'https://b2.test/put', headers: {}, expiresIn: 600 }),
  publicUrl: (k) => `https://cdn.test/${k}`,
});
stub('../services/billing/uploadLimits', {
  limitsFor: async () => ({ maxUploadBytes: tierBytes, maxAlbumItems: 30 }),
  invalidateUploadLimits: () => {},
});

const { uploadTicket } = require('./uploadController');

const call = async (body) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await uploadTicket({ user: { alanyaID: 7 }, body }, res);
  return res;
};
const media = (size) => ({ kind: 'media', fileName: 'v.mp4', mimetype: 'video/mp4', size });

(async () => {
  // Palier standard.
  let r = await call(media(40 * MB));
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.mode, 'direct');

  r = await call(media(80 * MB));
  assert.strictEqual(r.code, 413);
  assert.strictEqual(r.body.code, 'FILE_TOO_LARGE');
  assert.strictEqual(r.body.maxBytes, 50 * MB, 'le téléphone sait le plafond');

  // Palier payant.
  tierBytes = 200 * MB;
  r = await call(media(80 * MB));
  assert.strictEqual(r.code, 200, 'un abonné envoie 80 Mo');
  r = await call(media(200 * MB));
  assert.strictEqual(r.code, 200, 'jusqu\'à 200 Mo inclus');
  r = await call(media(200 * MB + 1));
  assert.strictEqual(r.code, 413);
  assert.strictEqual(r.body.maxBytes, 200 * MB);

  // Une photo de profil garde son plafond, abonné ou non.
  r = await call({ kind: 'avatar', fileName: 'a.jpg', mimetype: 'image/jpeg', size: 6 * MB });
  assert.strictEqual(r.code, 413);
  assert.strictEqual(r.body.maxBytes, 5 * MB);
  r = await call({ kind: 'avatar', fileName: 'a.jpg', mimetype: 'image/jpeg', size: 4 * MB });
  assert.strictEqual(r.code, 200);

  console.log('uploadTicketTier.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
