const assert = require('assert');
const { VERIFICATION: V, ACCOUNT_TYPE } = require('../../constants/accountTypes');
const {
  normalizeName, nameChanged, decideBadge, sameVerification, badgeChainEnd,
} = require('./verificationRules');

const END = '2027-10-10T00:00:00.000Z';
const START = '2026-10-10T00:00:00.000Z';
const NOW = new Date('2026-11-01T00:00:00.000Z');
const PAST = '2026-09-01T00:00:00.000Z';

const period = (startsAt, endsAt) => ({ starts_at: startsAt, ends_at: endsAt });
const decide = (over = {}) => decideBadge({
  revoked: false,
  accountType: ACCOUNT_TYPE.PERSONNEL,
  phase: 'paid',
  grantingPeriods: [period(START, END)],
  lastEnd: null,
  now: NOW,
  ...over,
});

// ── Noms (conservés pour le dossier business) ─────────────────────────────
assert.strictEqual(normalizeName('  Marie   KOUASSI '), 'marie kouassi');
assert.strictEqual(nameChanged('Marie Kouassi', 'marie  kouassi'), false);
assert.strictEqual(nameChanged('Marie Kouassi', 'Marie Kouassi-Diallo'), true);

// ── Chaîne de périodes ────────────────────────────────────────────────────
assert.strictEqual(badgeChainEnd([period(START, END)], NOW).toISOString(), END);
assert.strictEqual(
  badgeChainEnd([period(START, '2027-01-01T00:00:00.000Z'), period('2027-01-01T00:00:00.000Z', END)], NOW)
    .toISOString(),
  END,
);

// ── Révocation ────────────────────────────────────────────────────────────
assert.deepStrictEqual(decide({ revoked: true }), { status: V.REVOQUE, until: null });

// ── Comptes non personnels : ne pas écrire ────────────────────────────────
assert.strictEqual(decide({ accountType: ACCOUNT_TYPE.BUSINESS }), null);
assert.strictEqual(decide({ accountType: ACCOUNT_TYPE.OFFICIEL }), null);
assert.strictEqual(decide({ typeCompte: 1 }), null, 'équipe : pas de coche indigo');
assert.strictEqual(decide({ typeCompte: 2 }), null);

// ── Phase gratuite : aucune coche ─────────────────────────────────────────
assert.deepStrictEqual(decide({ phase: 'free' }), { status: V.NON_DEMANDE, until: null });
assert.deepStrictEqual(
  decide({ phase: 'free', grantingPeriods: [period(START, END)] }),
  { status: V.NON_DEMANDE, until: null },
  'même avec une période offerte, rien avant l\'activation',
);

// ── Abonné : coche jusqu'à la fin de la chaîne ────────────────────────────
{
  const v = decide();
  assert.strictEqual(v.status, V.VERIFIE);
  assert.strictEqual(v.until.toISOString(), END);
}

// Période à venir (payée pendant la grâce) : coche immédiate.
{
  const futureStart = '2026-12-01T00:00:00.000Z';
  const v = decide({
    phase: 'grace',
    grantingPeriods: [period(futureStart, END)],
  });
  assert.strictEqual(v.status, V.VERIFIE);
  assert.strictEqual(v.until.toISOString(), END);
}

// Période qui n'accorde pas la coche : pas de coche.
assert.deepStrictEqual(
  decide({ grantingPeriods: [] }),
  { status: V.NON_DEMANDE, until: null },
);

// ── Échu ──────────────────────────────────────────────────────────────────
assert.deepStrictEqual(
  decide({ grantingPeriods: [], lastEnd: PAST }),
  { status: V.EXPIRE, until: null },
);

// ── Rien à écrire ─────────────────────────────────────────────────────────
assert.strictEqual(sameVerification({ status: 2, until: null }, { status: 2, until: null }), true);
assert.strictEqual(sameVerification({ status: 2, until: new Date(END) }, { status: 2, until: END }), true);
assert.strictEqual(sameVerification({ status: 2, until: null }, { status: 2, until: END }), false);
assert.strictEqual(sameVerification({ status: 1, until: null }, { status: 2, until: null }), false);
assert.strictEqual(sameVerification(null, null), true);

console.log('verificationRules.test.js OK');
