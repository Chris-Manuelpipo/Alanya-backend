const assert = require('assert');
const {
  validatePurchasable,
  purchaseRefusal,
  PURCHASE_REFUSAL: R,
  isPatternReserved,
} = require('./alanyaPhone');

// ── Ce qui s'achète ────────────────────────────────────────────────────────
assert.deepStrictEqual(validatePurchasable('12345678'), { ok: true });
assert.deepStrictEqual(validatePurchasable('11223344'), { ok: true }, 'un XXYYZZTT se vend aussi');
assert.ok(isPatternReserved('11223344'), '… bien qu\'il reste hors du tirage à l\'inscription');
assert.strictEqual(validatePurchasable('1234').code, 'PHONE_NOT_PURCHASABLE', '4 chiffres : administration');
assert.strictEqual(validatePurchasable('007').code, 'PHONE_NOT_PURCHASABLE', '3 chiffres : administration');
assert.strictEqual(validatePurchasable('').code, 'PHONE_REQUIRED');
assert.strictEqual(validatePurchasable('123456').code, 'INVALID_PHONE_LENGTH');
assert.strictEqual(validatePurchasable('1234567a').code, 'PHONE_NOT_NUMERIC');

// ── Pourquoi un numéro n'est pas à vendre ──────────────────────────────────
const LIBRE = { isOwn: false, taken: false, setAside: false, heldByOther: false, quarantined: false };
assert.strictEqual(purchaseRefusal(LIBRE), null);
assert.strictEqual(purchaseRefusal({ ...LIBRE, isOwn: true, taken: true }), R.SAME, 'le sien avant « déjà utilisé »');
assert.strictEqual(purchaseRefusal({ ...LIBRE, taken: true, heldByOther: true }), R.TAKEN);
assert.strictEqual(purchaseRefusal({ ...LIBRE, setAside: true, heldByOther: true }), R.SET_ASIDE,
  'un refus définitif avant un refus qui passera');
assert.strictEqual(purchaseRefusal({ ...LIBRE, heldByOther: true, quarantined: true }), R.HELD);
assert.strictEqual(purchaseRefusal({ ...LIBRE, quarantined: true }), R.QUARANTINE);

console.log('alanyaPhone.test.js OK');
