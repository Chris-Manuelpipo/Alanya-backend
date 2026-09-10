const assert = require('assert');
const { parseSoclePayload } = require('./soclePayload');
const { VERIFICATION } = require('../constants/accountTypes');

// Corps vide : rien à écrire, mais pas une erreur (le contrôleur répond
// NO_FIELDS_TO_UPDATE).
assert.deepStrictEqual(parseSoclePayload({}), { ok: true, value: {} });
assert.deepStrictEqual(parseSoclePayload(undefined), { ok: true, value: {} });

// Genre de compte
assert.deepStrictEqual(parseSoclePayload({ account_type: 1 }).value, { accountType: 1 });
assert.deepStrictEqual(parseSoclePayload({ account_type: '2' }).value, { accountType: 2 });
for (const bad of [3, -1, 1.5, '', 'business', true]) {
  const r = parseSoclePayload({ account_type: bad });
  assert.strictEqual(r.ok, false, `account_type ${JSON.stringify(bad)} doit être refusé`);
  assert.strictEqual(r.code, 'INVALID_ACCOUNT_TYPE');
}

// La coche ne se saisit plus : elle suit le dossier et l'abonnement (lot E).
for (const body of [
  { verification_status: 2 },
  { verification_status: 0 },
  { verified_until: '2027-10-10T00:00:00Z' },
  { verified_until: null },
  { account_type: 0, verification_status: 2 },
]) {
  const r = parseSoclePayload(body);
  assert.strictEqual(r.ok, false, `${JSON.stringify(body)} doit être refusé`);
  assert.strictEqual(r.code, 'FIELD_IMMUTABLE');
}

// Ordre fixé par la conception : 4 = révoqué, 5 = expiré.
assert.strictEqual(VERIFICATION.REVOQUE, 4);
assert.strictEqual(VERIFICATION.EXPIRE, 5);

console.log('soclePayload.test.js OK');
