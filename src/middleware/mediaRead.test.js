const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../services/mediaStorage');
const { mediaRead } = require('./mediaRead');
const { mediaExpiryGuard } = require('./mediaExpiry');

const CONFIG_B2 = {
  demande: 'b2',
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  region: 'eu-central-003',
  bucket: 'alanyaprivate',
  keyId: 'cle-test',
  appKey: 'secret-test',
};

/** Réponse Express minimale : on n'observe que ce que le middleware décide. */
function fausseReponse() {
  return {
    code: null,
    entetes: {},
    corps: null,
    redirige: null,
    status(c) { this.code = c; return this; },
    set(k, v) { this.entetes[k] = v; return this; },
    setHeader(k, v) { this.entetes[k] = v; },
    json(o) { this.corps = o; return this; },
    redirect(c, u) { this.code = c; this.redirige = u; return this; },
    sendFile(p) { this.envoye = p; return this; },
  };
}

async function passer(req, { root }) {
  const res = fausseReponse();
  let suivant = false;
  await mediaRead({ root })(req, res, () => { suivant = true; });
  return { res, suivant };
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
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'media-read-'));

  await test('stockage disque : ne fait rien, express.static sert', async () => {
    storage.configureForTests({ ...CONFIG_B2, demande: 'disk' });
    const { res, suivant } = await passer({ method: 'GET', path: '/media/2026-09-15/images/a.jpg' }, { root: racine });
    assert.ok(suivant);
    assert.strictEqual(res.code, null);
  });

  storage.configureForTests(CONFIG_B2);

  await test('GET : 302 vers un lien signé, jamais mis en cache', async () => {
    const { res, suivant } = await passer({ method: 'GET', path: '/media/2026-09-15/images/a.jpg' }, { root: racine });
    assert.ok(!suivant);
    assert.strictEqual(res.code, 302);
    const u = new URL(res.redirige);
    assert.strictEqual(u.pathname, '/media/2026-09-15/images/a.jpg');
    assert.ok(u.searchParams.get('X-Amz-Signature'));
    assert.strictEqual(res.entetes['Cache-Control'], 'no-store');
  });

  await test('HEAD : lien signé pour HEAD, distinct du lien GET', async () => {
    const g = await passer({ method: 'GET', path: '/images/a.jpg' }, { root: racine });
    const h = await passer({ method: 'HEAD', path: '/images/a.jpg' }, { root: racine });
    assert.strictEqual(h.res.code, 302);
    assert.notStrictEqual(
      new URL(g.res.redirige).searchParams.get('X-Amz-Signature'),
      new URL(h.res.redirige).searchParams.get('X-Amz-Signature'),
    );
  });

  await test('transition : un fichier encore sur le disque est servi comme avant', async () => {
    fs.mkdirSync(path.join(racine, 'images'), { recursive: true });
    fs.writeFileSync(path.join(racine, 'images', 'local.jpg'), 'x');
    const { res, suivant } = await passer({ method: 'GET', path: '/images/local.jpg' }, { root: racine });
    assert.ok(suivant);
    assert.strictEqual(res.code, null);
  });

  await test('hors médias, remontée, autre méthode : laissé à la suite (404)', async () => {
    for (const req of [
      { method: 'GET', path: '/exports/export_1.json' },
      { method: 'GET', path: '/media/../../etc/passwd' },
      { method: 'POST', path: '/images/a.jpg' },
    ]) {
      const { res, suivant } = await passer(req, { root: racine });
      assert.ok(suivant, `${req.method} ${req.path}`);
      assert.strictEqual(res.code, null);
    }
  });

  await test('signature impossible : 503 STORAGE_UNAVAILABLE', async () => {
    const original = storage.presignRead;
    storage.presignRead = async () => { throw new Error('horloge'); };
    try {
      const { res } = await passer({ method: 'GET', path: '/images/a.jpg' }, { root: racine });
      assert.strictEqual(res.code, 503);
      assert.strictEqual(res.corps.code, 'STORAGE_UNAVAILABLE');
    } finally {
      storage.presignRead = original;
    }
  });

  await test('adresse héritée : le relais désigne la clé de partition, mediaRead y redirige', async () => {
    const maintenant = Date.parse('2026-09-15T12:00:00Z');
    const envoi = maintenant - 2 * 24 * 3600 * 1000; // partition vivante
    const nom = `media_1_${envoi}.jpg`;
    const req = { method: 'GET', path: `/media/images/${nom}` };
    const garde = mediaExpiryGuard({ retentionDays: 30, now: () => maintenant });
    let suivant = false;
    garde(req, fausseReponse(), () => { suivant = true; });
    assert.ok(suivant);
    assert.strictEqual(req.mediaKey, `media/2026-09-13/images/${nom}`);

    const { res } = await passer(req, { root: racine });
    assert.strictEqual(res.code, 302);
    assert.strictEqual(new URL(res.redirige).pathname, `/media/2026-09-13/images/${nom}`);
  });

  fs.rmSync(racine, { recursive: true });
  console.log(`mediaRead : ${ok} tests passés`);
})();
