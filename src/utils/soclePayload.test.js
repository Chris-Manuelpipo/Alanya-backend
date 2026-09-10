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

// État de vérification : les six valeurs, pas une de plus.
for (const v of Object.values(VERIFICATION)) {
  assert.strictEqual(parseSoclePayload({ verification_status: v }).value.verificationStatus, v);
}
for (const bad of [6, 42, -1, '', ' ', 'verifie', true, 2.5]) {
  const r = parseSoclePayload({ verification_status: bad });
  assert.strictEqual(r.ok, false, `verification_status ${JSON.stringify(bad)} doit être refusé`);
  assert.strictEqual(r.code, 'INVALID_VERIFICATION_STATUS');
}

// Ordre fixé par la conception : 4 = révoqué, 5 = expiré.
assert.strictEqual(VERIFICATION.REVOQUE, 4);
assert.strictEqual(VERIFICATION.EXPIRE, 5);

// Échéance
const ok = parseSoclePayload({ verified_until: '2027-10-10T00:00:00Z' });
assert.ok(ok.value.verifiedUntil instanceof Date);
assert.strictEqual(ok.value.verifiedUntil.toISOString(), '2027-10-10T00:00:00.000Z');
assert.deepStrictEqual(parseSoclePayload({ verified_until: null }).value, { verifiedUntil: null });
assert.deepStrictEqual(parseSoclePayload({ verified_until: '' }).value, { verifiedUntil: null });
for (const bad of ['demain', '2027-13-45', 12345, {}]) {
  const r = parseSoclePayload({ verified_until: bad });
  assert.strictEqual(r.ok, false, `verified_until ${JSON.stringify(bad)} doit être refusé`);
  assert.strictEqual(r.code, 'INVALID_VERIFIED_UNTIL');
}

// Un champ absent n'apparaît pas dans value : il ne doit pas être écrit.
assert.deepStrictEqual(
  parseSoclePayload({ account_type: 0, verification_status: 2 }).value,
  { accountType: 0, verificationStatus: 2 },
);

console.log('soclePayload.test.js OK');
