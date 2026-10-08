const assert = require('assert');
const { createUploadLimits } = require('./uploadLimits');
const { TIER_LIMITS } = require('../../constants/billing');
const { isPaidTier, tierLimits, decideEntitlements } = require('./rules');

const MB = 1024 * 1024;
const DAY = 86_400_000;
const T0 = new Date('2026-10-03T10:00:00Z');
let nowMs = T0.getTime();
const clock = () => new Date(nowMs);
const day = (n) => new Date(T0.getTime() + n * DAY);

// ── Les plafonds de chaque palier ──────────────────────────────────────────
assert.strictEqual(TIER_LIMITS.standard.maxUploadBytes, 100 * MB);
assert.strictEqual(TIER_LIMITS.standard.maxAlbumItems, 30);
assert.strictEqual(TIER_LIMITS.paid.maxUploadBytes, 200 * MB);
assert.strictEqual(TIER_LIMITS.paid.maxAlbumItems, 100);
assert.strictEqual(tierLimits(true), TIER_LIMITS.paid);
assert.strictEqual(tierLimits(false), TIER_LIMITS.standard);

// ── Qui a payé ? ───────────────────────────────────────────────────────────
{
  const now = T0;
  assert.strictEqual(isPaidTier({ phase: 'paid', coveredUntil: day(100), now }), true, 'abonnement en cours');
  assert.strictEqual(isPaidTier({ phase: 'paid', coveredUntil: day(-1), now }), false, 'abonnement échu');
  assert.strictEqual(isPaidTier({ phase: 'paid', coveredUntil: now, now }), false, 'finit maintenant');
  assert.strictEqual(isPaidTier({ phase: 'paid', coveredUntil: null, now }), false, 'en essai ou jamais abonné');
  assert.strictEqual(isPaidTier({ phase: 'paid', exempt: true, now }), true, 'équipe, compte officiel');
  assert.strictEqual(isPaidTier({ phase: 'grace', coveredUntil: day(100), now }), false, 'grâce : tout le monde au standard');
  assert.strictEqual(isPaidTier({ phase: 'free', coveredUntil: day(100), now }), false, 'payant éteint');
  assert.strictEqual(isPaidTier({ phase: 'free', exempt: true, now }), false, 'payant éteint, même exempté');
}

// ── Ce que le téléphone reçoit ─────────────────────────────────────────────
{
  const CATALOG = [{ code: 'translation', is_paid: 1, is_available: 1 }];
  const PAID = { model: 2, paid_enabled: 1, grace_until: day(-30), trial_days: 90 };
  const run = (o) => decideEntitlements({ settings: PAID, catalog: CATALOG, now: T0, ...o });
  const periods = [{ plan_code: 'plus_annuel', starts_at: day(-10), ends_at: day(355), source: 4 }];

  const abonne = run({ createdAt: day(-200), periods });
  assert.deepStrictEqual(abonne.limits, { maxUploadBytes: 200 * MB, maxAlbumItems: 100, tier: 'paid' });

  const essai = run({ createdAt: day(-20) });
  assert.deepStrictEqual(essai.limits, { maxUploadBytes: 100 * MB, maxAlbumItems: 30, tier: 'standard' },
    'en essai : palier standard');

  const aVenir = run({
    createdAt: day(-20),
    periods: [{ plan_code: 'plus_annuel', starts_at: day(70), ends_at: day(435), source: 4 }],
  });
  assert.strictEqual(aVenir.limits.tier, 'standard', 'abonnement payé pendant l\'essai : pas encore commencé');

  assert.strictEqual(run({ createdAt: day(-200) }).limits.tier, 'standard', 'essai fini, sans abonnement');
  assert.strictEqual(run({ createdAt: day(-200), exempt: true }).limits.tier, 'paid', 'équipe');
  assert.strictEqual(
    run({ settings: { ...PAID, paid_enabled: 0 }, createdAt: day(-200), periods }).limits.tier,
    'standard', 'payant éteint',
  );
  // Régime Alanya Plus : un abonné y a payé de même.
  assert.strictEqual(
    decideEntitlements({
      settings: { ...PAID, model: 1 }, catalog: CATALOG, periods, createdAt: day(-200), now: T0,
    }).limits.tier,
    'paid',
  );
}

// ── Le service ─────────────────────────────────────────────────────────────
(async () => {
  const TRIAL_ON = { model: 2, paid_enabled: 1, grace_until: day(-30), trial_days: 90 };
  const build = ({ settings = TRIAL_ON, account, env = {} } = {}) => {
    const calls = { account: 0 };
    const state = { account };
    const svc = createUploadLimits({
      getSettings: async () => settings,
      loadAccount: async () => { calls.account++; return state.account; },
      clock,
      env,
    });
    return { svc, calls, state };
  };
  const acct = (extra = {}) => ({ type_compte: 0, account_type: 0, covered_until: null, ...extra });

  // Hors phase payante : jamais de lecture.
  for (const settings of [{ ...TRIAL_ON, paid_enabled: 0 }, { ...TRIAL_ON, grace_until: day(10) }]) {
    const { svc, calls } = build({ settings, account: acct({ covered_until: day(300) }) });
    assert.strictEqual((await svc.limitsFor(7)).maxUploadBytes, 100 * MB);
    assert.strictEqual(calls.account, 0);
  }

  // Abonné : 200 Mo, retenu jusqu'à la fin de l'abonnement.
  {
    const { svc, calls } = build({ account: acct({ covered_until: new Date(T0.getTime() + 30_000) }) });
    assert.strictEqual((await svc.limitsFor(7)).maxUploadBytes, 200 * MB);
    nowMs += 29_000;
    assert.strictEqual((await svc.limitsFor(7)).maxUploadBytes, 200 * MB);
    assert.strictEqual(calls.account, 1, 'retenu');
    nowMs += 2_000; // l'abonnement a pris fin
    assert.strictEqual((await svc.limitsFor(7)).maxUploadBytes, 100 * MB, 'plus un octet de trop');
    assert.strictEqual(calls.account, 2);
    nowMs = T0.getTime();
  }

  // Un abonné de longue durée est relu au plus une minute plus tard.
  {
    const { svc, calls } = build({ account: acct({ covered_until: day(300) }) });
    await svc.limitsFor(7);
    nowMs += 61_000;
    await svc.limitsFor(7);
    assert.strictEqual(calls.account, 2);
    nowMs = T0.getTime();
  }

  // Un code activé : l'invalidation rouvre tout de suite.
  {
    const { svc, state } = build({ account: acct() });
    assert.strictEqual((await svc.limitsFor(7)).maxUploadBytes, 100 * MB);
    state.account = acct({ covered_until: day(365) });
    // Sans invalidation, le palier standard reste retenu (au plus une minute).
    svc.invalidateUploadLimits(7);
    assert.strictEqual((await svc.limitsFor(7)).maxUploadBytes, 200 * MB);
  }

  // Équipe : palier payant. Compte inconnu ou panne : palier standard.
  assert.strictEqual((await build({ account: acct({ type_compte: 1 }) }).svc.limitsFor(7)).maxAlbumItems, 100);
  assert.strictEqual((await build({ account: null }).svc.limitsFor(7)).maxAlbumItems, 30);
  {
    const down = createUploadLimits({
      getSettings: async () => TRIAL_ON,
      loadAccount: async () => { const e = new Error('boom'); e.code = 'ECONNREFUSED'; throw e; },
      clock,
    });
    assert.strictEqual((await down.limitsFor(7)).maxUploadBytes, 100 * MB, 'panne : standard, jamais 200 Mo par défaut');
    assert.strictEqual(down.cacheSize(), 0);
  }

  console.log('uploadLimits.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
