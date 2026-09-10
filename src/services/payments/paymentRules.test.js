const assert = require('assert');
const {
  PAYMENT_STATUS_NAME,
  normalizeMsisdn,
  simulatedOutcome,
  signSimulated,
  verifySimulated,
  addMonths,
  nextPeriodStart,
} = require('./paymentRules');
const { isBillingTester, billingTesterIds } = require('../billing/rules');

// ── Numéros ────────────────────────────────────────────────────────────────
assert.strictEqual(normalizeMsisdn('+237 6 99 12 34 00'), '237699123400');
assert.strictEqual(normalizeMsisdn('699123400'), '237699123400', 'sans indicatif : Cameroun');
assert.strictEqual(normalizeMsisdn('00237699123400'), '237699123400');
assert.strictEqual(normalizeMsisdn('237599123400'), null, 'un mobile camerounais commence par 6');
assert.strictEqual(normalizeMsisdn('12345'), null);
assert.strictEqual(normalizeMsisdn('abc'), null);
assert.strictEqual(normalizeMsisdn('+33 6 12 34 56 78'), '33612345678', 'ailleurs, avec indicatif');

// ── Simulateur ─────────────────────────────────────────────────────────────
assert.deepStrictEqual(simulatedOutcome('237699123400'), { outcome: 'succeeded' });
assert.deepStrictEqual(simulatedOutcome('237699123401'), { outcome: 'failed', failureCode: 'INSUFFICIENT_FUNDS' });
assert.deepStrictEqual(simulatedOutcome('237699123402'), { outcome: 'failed', failureCode: 'USER_DECLINED' });
assert.deepStrictEqual(simulatedOutcome('237699123403'), { outcome: 'none' });
assert.deepStrictEqual(simulatedOutcome('237699123404'), { outcome: 'succeeded', duplicate: true });
assert.deepStrictEqual(simulatedOutcome('237699123477'), { outcome: 'succeeded' });

// ── Signature ──────────────────────────────────────────────────────────────
{
  const body = Buffer.from(JSON.stringify({ providerRef: 'SIM-ABC', outcome: 'succeeded' }));
  const sig = signSimulated(body, 'secret');
  assert.ok(verifySimulated(body, sig, 'secret'));
  assert.ok(!verifySimulated(body, sig, 'autre secret'), 'mauvais secret');
  assert.ok(!verifySimulated(Buffer.from('{"falsifié":1}'), sig, 'secret'), 'corps modifié');
  assert.ok(!verifySimulated(body, '', 'secret'), 'signature absente');
}

// ── Périodes ───────────────────────────────────────────────────────────────
assert.strictEqual(addMonths(new Date('2026-10-10T00:00:00Z'), 12).toISOString(), '2027-10-10T00:00:00.000Z');
assert.strictEqual(addMonths(new Date('2026-01-31T08:00:00Z'), 1).toISOString(), '2026-02-28T08:00:00.000Z', 'pas de débordement en mars');
assert.strictEqual(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString(), '2028-02-29T00:00:00.000Z', 'année bissextile');
assert.strictEqual(addMonths(new Date('2026-12-15T00:00:00Z'), 1).toISOString(), '2027-01-15T00:00:00.000Z');

{
  const now = new Date('2026-09-22T12:00:00Z');
  assert.strictEqual(nextPeriodStart({ now }).toISOString(), now.toISOString(), 'aucune période : maintenant');
  assert.strictEqual(
    nextPeriodStart({ now, graceUntil: '2026-10-10T00:00:00Z' }).toISOString(),
    '2026-10-10T00:00:00.000Z', 'payé pendant la grâce : commence à sa fin',
  );
  assert.strictEqual(
    nextPeriodStart({ now, currentEnd: '2026-11-17T00:00:00Z' }).toISOString(),
    '2026-11-17T00:00:00.000Z', 'renouvellement anticipé : à la suite',
  );
  assert.strictEqual(
    nextPeriodStart({ now, currentEnd: '2026-08-01T00:00:00Z' }).toISOString(),
    now.toISOString(), 'période échue : maintenant',
  );
}

assert.strictEqual(PAYMENT_STATUS_NAME[2], 'succeeded');

// ── Comptes testeurs ───────────────────────────────────────────────────────
assert.deepStrictEqual([...billingTesterIds({ BILLING_TEST_USERS: ' 12, 34,abc,0, ' })], [12, 34]);
assert.ok(isBillingTester(34, { BILLING_TEST_USERS: '12,34' }));
assert.ok(!isBillingTester(35, { BILLING_TEST_USERS: '12,34' }));
assert.ok(!isBillingTester(12, {}), 'aucun testeur par défaut');

console.log('paymentRules.test.js OK');
