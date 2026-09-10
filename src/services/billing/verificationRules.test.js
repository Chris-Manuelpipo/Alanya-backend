const assert = require('assert');
const { VERIFICATION: V } = require('../../constants/accountTypes');
const { REQUEST_STATUS: R } = require('../../constants/verification');
const {
  normalizeName, nameChanged, decideVerification, sameVerification,
} = require('./verificationRules');

const END = '2027-10-10T00:00:00.000Z';
const GRACE = '2026-10-01T00:00:00.000Z';
const ents = (over = {}) => ({
  phase: 'paid',
  exempt: false,
  graceUntil: null,
  period: { endsAt: END },
  features: { verified_badge: true },
  ...over,
});
const approved = { status: R.APPROVED, name_at_approval: 'Marie Kouassi' };
const decide = (request, entitlements = ents(), currentName = 'Marie Kouassi') =>
  decideVerification({ request, currentName, entitlements });

// ── Noms ──────────────────────────────────────────────────────────────────
assert.strictEqual(normalizeName('  Marie   KOUASSI '), 'marie kouassi');
assert.strictEqual(nameChanged('Marie Kouassi', 'marie  kouassi'), false);
assert.strictEqual(nameChanged('Marie Kouassi', 'Marie Kouassi-Diallo'), true);

// ── Dossier ───────────────────────────────────────────────────────────────
assert.deepStrictEqual(decide(null), { status: V.NON_DEMANDE, until: null });
assert.strictEqual(decide({ status: R.PENDING }).status, V.EN_COURS);
assert.strictEqual(decide({ status: R.DOCUMENT_REQUESTED }).status, V.EN_COURS);
assert.strictEqual(decide({ status: R.REFUSED }).status, V.REFUSE);
assert.strictEqual(decide({ status: R.REVOKED }).status, V.REVOQUE);

// ── Approuvé : la coche suit l'abonnement ─────────────────────────────────
{
  const v = decide(approved);
  assert.strictEqual(v.status, V.VERIFIE);
  assert.strictEqual(v.until.toISOString(), END);
}
assert.deepStrictEqual(decide(approved, ents({ features: { verified_badge: false }, period: null })),
  { status: V.EXPIRE, until: null }, 'échu : la coche tombe');
assert.deepStrictEqual(decide(approved, ents({ phase: 'free', period: null })),
  { status: V.VERIFIE, until: null }, 'phase gratuite : vérification seule');
assert.strictEqual(decide(approved, ents({ phase: 'grace', period: null, graceUntil: GRACE })).until.toISOString(),
  GRACE, 'la grâce porte la coche jusqu\'à sa fin');
assert.strictEqual(
  decide(approved, ents({ phase: 'grace', period: { endsAt: END }, graceUntil: GRACE })).until.toISOString(),
  END,
);
assert.deepStrictEqual(decide(approved, ents({ exempt: true })), { status: V.VERIFIE, until: null });
assert.deepStrictEqual(decide(approved, null), { status: V.VERIFIE, until: null },
  'droits indisponibles : la coche reste');

// ── Changement de nom : nouvel examen ─────────────────────────────────────
assert.strictEqual(decide(approved, ents(), 'Marie Diallo').status, V.EN_COURS);

// ── Rien à écrire ─────────────────────────────────────────────────────────
assert.strictEqual(sameVerification({ status: 2, until: null }, { status: 2, until: null }), true);
assert.strictEqual(sameVerification({ status: 2, until: new Date(END) }, { status: 2, until: END }), true);
assert.strictEqual(sameVerification({ status: 2, until: null }, { status: 2, until: END }), false);
assert.strictEqual(sameVerification({ status: 1, until: null }, { status: 2, until: null }), false);

console.log('verificationRules.test.js OK');
