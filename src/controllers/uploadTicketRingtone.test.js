/**
 * Ticket `ringtone` (POST /api/upload/ticket) : dépôt d'une sonnerie importée.
 *
 * Les droits d'accès sont remplacés dans `require.cache` avant le chargement
 * du contrôleur : le test ne lit jamais la base.
 */
const assert = require('assert');
const { S3Client } = require('@aws-sdk/client-s3');

process.env.RINGTONE_KEY_SECRET = 'secret-de-test';

let droits = { features: { list_ringtones: true } };
const cheminDroits = require.resolve('../services/billing/entitlements');
require.cache[cheminDroits] = {
  id: cheminDroits,
  filename: cheminDroits,
  loaded: true,
  exports: { entitlementsOrNull: async () => droits, entitlementsFor: async () => droits },
};

const storage = require('../services/mediaStorage');
const { uploadTicket } = require('./uploadController');

const CONFIG_B2 = {
  demande: 'b2',
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

function fauxClient(reponses = {}) {
  const client = new S3Client({
    endpoint: CONFIG_B2.endpoint,
    region: CONFIG_B2.region,
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const repondre = reponses[context.commandName];
      const output = repondre ? await repondre(args.input) : {};
      return { output: { $metadata: {}, ...output }, response: {} };
    },
    { step: 'initialize', name: 'fauxReseau', priority: 'high' },
  );
  return client;
}
const introuvable = () => {
  throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
};

async function demander(corps) {
  const res = {
    code: 200,
    corps: null,
    status(c) { this.code = c; return this; },
    json(o) { this.corps = o; return this; },
  };
  await uploadTicket({ body: corps, user: { alanyaID: 12 } }, res);
  return res;
}

const EMPREINTE = 'ab'.repeat(32);
const valide = { kind: 'ringtone', sha256: EMPREINTE, mimetype: 'audio/mpeg', size: 400_000 };

(async () => {
  storage.configureForTests({ ...CONFIG_B2, client: fauxClient({ HeadObjectCommand: introuvable }) });

  // ── Absent : lien d'envoi signé vers profilemedia ──────────────────────
  {
    const res = await demander(valide);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.corps.mode, 'direct');
    assert.strictEqual(new URL(res.corps.uploadUrl).host, 'profilemedia.s3.eu-central-003.backblazeb2.com');
    assert.ok(res.corps.url.startsWith('https://profilemedia.s3.eu-central-003.backblazeb2.com/ringtones/12/'));
    assert.strictEqual(res.corps.headers['Content-Type'], 'audio/mpeg');
  }

  // ── Déjà là : rien à envoyer, même adresse ─────────────────────────────
  {
    storage.configureForTests({ ...CONFIG_B2, client: fauxClient({ HeadObjectCommand: () => ({}) }) });
    const res = await demander({ ...valide, sha256: EMPREINTE.toUpperCase() });
    assert.strictEqual(res.corps.mode, 'exists');
    assert.ok(res.corps.url.includes('/ringtones/12/'));
    assert.strictEqual(res.corps.uploadUrl, undefined);
  }

  // ── Refus ──────────────────────────────────────────────────────────────
  assert.strictEqual((await demander({ ...valide, sha256: 'xyz' })).code, 400);
  assert.strictEqual((await demander({ ...valide, mimetype: 'image/png' })).code, 400);
  assert.strictEqual((await demander({ ...valide, size: 6 * 1024 * 1024 })).code, 413);
  assert.strictEqual((await demander({ ...valide, size: 0 })).code, 400);
  {
    droits = { features: { list_ringtones: false } };
    const res = await demander(valide);
    assert.strictEqual(res.code, 403);
    assert.strictEqual(res.corps.code, 'SUBSCRIPTION_REQUIRED');
    droits = { features: { list_ringtones: true } };
  }

  // ── Indisponible : la sonnerie reste sur le téléphone, comme avant ─────
  {
    const secret = process.env.RINGTONE_KEY_SECRET;
    delete process.env.RINGTONE_KEY_SECRET;
    assert.deepStrictEqual((await demander(valide)).corps, { mode: 'unavailable' });
    process.env.RINGTONE_KEY_SECRET = secret;

    storage.configureForTests({ ...CONFIG_B2, demande: 'disk' });
    assert.deepStrictEqual((await demander(valide)).corps, { mode: 'unavailable' });
  }

  // ── Les autres types de ticket ne changent pas ─────────────────────────
  assert.strictEqual((await demander({ kind: 'autre', mimetype: 'image/png', size: 10 })).code, 400);

  storage.configureForTests({
    ...CONFIG_B2,
    publics: {
      profile: { bucket: '', keyId: '', appKey: '' },
      profilemedia: { bucket: '', keyId: '', appKey: '' },
    },
  });
  console.log('uploadTicket ringtone: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
