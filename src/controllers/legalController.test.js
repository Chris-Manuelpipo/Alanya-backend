/**
 * Pages légales — `node src/controllers/legalController.test.js`.
 *
 * Google compare ces pages à l'écran OAuth et au comportement de l'app.
 * Une régression ici (scope Drive disparu, accueil sans lien vers la
 * politique, page non indexable) ferait échouer la vérification de marque.
 */

const assert = require('assert');
const {
  showHome,
  showPrivacy,
  showTerms,
  showLicenses,
  langueDe,
} = require('./legalController');

let ok = 0;
const test = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

function fauxReq({ query = {}, headers = {} } = {}) {
  return { query, headers };
}

function fauxRes() {
  return {
    typeVal: null,
    corps: null,
    headers: {},
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    type(t) {
      this.typeVal = t;
      return this;
    },
    send(c) {
      this.corps = c;
      return this;
    },
  };
}

const rendre = (handler, req) => {
  const res = fauxRes();
  handler(req, res);
  return res;
};

test('langueDe : query lang=en l\'emporte sur Accept-Language', () => {
  assert.strictEqual(
    langueDe(fauxReq({ query: { lang: 'en' }, headers: { 'accept-language': 'fr' } })),
    'en',
  );
});

test('langueDe : valeur inconnue retombe sur fr', () => {
  assert.strictEqual(langueDe(fauxReq({ query: { lang: 'zh' } })), 'fr');
});

test('accueil FR décrit Alanya et pointe vers confidentialité et conditions', () => {
  const res = rendre(showHome, fauxReq());
  assert.strictEqual(res.typeVal, 'html');
  assert.match(res.corps, /Alanya/);
  assert.match(res.corps, /\/legal\/privacy/);
  assert.match(res.corps, /\/legal\/terms/);
  assert.match(res.corps, /Google Drive/);
  assert.doesNotMatch(res.corps, /noindex/);
});

test('accueil EN est servi pour lang=en', () => {
  const res = rendre(showHome, fauxReq({ query: { lang: 'en' } }));
  assert.match(res.corps, /privacy policy/);
  assert.match(res.corps, /lang="en"/);
});

test('politique : scope drive.file, dossier Alanya, pas de bout en bout', () => {
  const res = rendre(showPrivacy, fauxReq());
  assert.match(res.corps, /googleapis\.com\/auth\/drive\.file/);
  assert.match(res.corps, /drive\.file/);
  assert.match(res.corps, />Alanya</);
  assert.match(res.corps, /bout en bout/);
  assert.match(res.corps, /Limited Use/);
  assert.match(res.corps, /alanyapro64@gmail\.com/);
  assert.match(res.corps, /AES-256-GCM/);
});

test('politique EN reprend le même contrat Drive', () => {
  const res = rendre(showPrivacy, fauxReq({ query: { lang: 'en' } }));
  assert.match(res.corps, /googleapis\.com\/auth\/drive\.file/);
  assert.match(res.corps, /end-to-end/);
  assert.match(res.corps, /Limited Use/);
});

test('conditions et licences répondent en HTML public', () => {
  for (const h of [showTerms, showLicenses]) {
    const res = rendre(h, fauxReq());
    assert.strictEqual(res.typeVal, 'html');
    assert.strictEqual(res.headers['Cache-Control'], 'public, max-age=3600');
    assert.match(res.corps, /Alanya/);
  }
});

if (!process.exitCode) {
  console.log(`legalController.test.js ${ok} ok`);
}
