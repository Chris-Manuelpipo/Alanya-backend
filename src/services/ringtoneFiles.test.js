const assert = require('assert');
const { S3Client } = require('@aws-sdk/client-s3');

process.env.RINGTONE_KEY_SECRET = 'secret-de-test';

const storage = require('./mediaStorage');
const { soundUrl, cleanRingtones, DELAI_DE_GRACE_MS } = require('./ringtoneFiles');

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

/** Vrai client S3, réseau court-circuité (voir mediaStorage.test.js). */
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

const MAINTENANT = Date.parse('2026-09-27T12:00:00Z');
const A = 'a'.repeat(64); // utilisée par une liste
const B = 'b'.repeat(64); // plus utilisée, ancienne
const C = 'c'.repeat(64); // plus utilisée, déposée à l'instant
const cle = (h) => storage.ringtoneKey({ alanyaID: 12, sha256: h });

function bucketAvec(fichiers) {
  return fauxClient({
    ListObjectsV2Command: () => ({
      Contents: fichiers.map(([h, age]) => ({ Key: cle(h), Size: 1, LastModified: new Date(MAINTENANT - age) })),
      IsTruncated: false,
    }),
    ListObjectVersionsCommand: (input) => ({ Versions: [{ Key: input.Prefix, VersionId: 'v1' }] }),
  });
}

const baseAvecListes = (listes) => ({ execute: async () => [listes] });

(async () => {
  // ── Adresse d'un son de liste ─────────────────────────────────────────
  storage.configureForTests(CONFIG_B2);
  assert.strictEqual(soundUrl(12, 'builtin', 'notif_pop'), null, 'son fourni : rien à servir');
  assert.strictEqual(soundUrl(12, 'custom', null), null);
  const url = soundUrl(12, 'custom', A);
  assert.ok(url.startsWith('https://profilemedia.s3.eu-central-003.backblazeb2.com/ringtones/12/'), url);
  assert.ok(!url.includes(A), "l'empreinte n'apparaît pas dans l'adresse");
  storage.configureForTests({ ...CONFIG_B2, keyId: '' });
  assert.strictEqual(soundUrl(12, 'custom', A), null, 'sans Backblaze, aucune adresse');

  // ── Nettoyage : seulement les orphelines, et pas celles qui arrivent ──
  {
    const { client, appels } = bucketAvec([[A, 5 * DELAI_DE_GRACE_MS], [B, 5 * DELAI_DE_GRACE_MS], [C, 60_000]]);
    storage.configureForTests({ ...CONFIG_B2, client });
    const db = baseAvecListes([
      { msg_sound_type: 'custom', msg_sound_id: A, call_sound_type: 'builtin', call_sound_id: 'notif_pop' },
    ]);
    assert.strictEqual(await cleanRingtones(12, { db, now: MAINTENANT }), 1);
    const supprimees = appels.filter((a) => a.commande === 'DeleteObjectCommand').map((a) => a.input.Key);
    // Supprimée dans son bucket public et dans le privé, où elle a pu naître.
    assert.deepStrictEqual(supprimees, [cle(B), cle(B)]);
    assert.strictEqual(appels.find((a) => a.commande === 'ListObjectsV2Command').input.Prefix, 'ringtones/12/');
  }

  // ── Purge des données payantes, suppression du compte : tout part ────
  {
    const { client, appels } = bucketAvec([[A, 5 * DELAI_DE_GRACE_MS], [C, 60_000]]);
    storage.configureForTests({ ...CONFIG_B2, client });
    const db = { execute: async () => { throw new Error('la base ne doit pas être lue'); } };
    assert.strictEqual(await cleanRingtones(12, { tout: true, db, now: MAINTENANT }), 2);
    assert.strictEqual(appels.filter((a) => a.commande === 'DeleteObjectCommand').length, 4);
  }

  // ── Sans secret, rien ne se recalcule : aucun nettoyage partiel ──────
  {
    const { client, appels } = bucketAvec([[B, 5 * DELAI_DE_GRACE_MS]]);
    storage.configureForTests({ ...CONFIG_B2, client });
    const secret = process.env.RINGTONE_KEY_SECRET;
    delete process.env.RINGTONE_KEY_SECRET;
    assert.strictEqual(await cleanRingtones(12, { db: baseAvecListes([]), now: MAINTENANT }), 0);
    assert.strictEqual(appels.length, 0);
    process.env.RINGTONE_KEY_SECRET = secret;
  }

  // ── Backblaze non configuré : rien à faire ────────────────────────────
  storage.configureForTests({ ...CONFIG_B2, keyId: '' });
  assert.strictEqual(await cleanRingtones(12, { db: baseAvecListes([]) }), 0);

  storage.configureForTests({
    ...CONFIG_B2,
    publics: {
      profile: { bucket: '', keyId: '', appKey: '' },
      profilemedia: { bucket: '', keyId: '', appKey: '' },
    },
  });
  console.log('ringtoneFiles: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
