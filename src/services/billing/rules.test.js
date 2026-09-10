const assert = require('assert');
const {
  phaseAt,
  resolvePeriods,
  decideEntitlements,
  activationBlocker,
  parseSettingsPatch,
  parsePlanPayload,
  parseFeaturePatch,
  parseReason,
} = require('./rules');

const NOW = new Date('2026-09-22T12:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86_400_000);

const CATALOG = [
  { code: 'translation', is_paid: 1, is_available: 1 },
  { code: 'backup', is_paid: 1, is_available: 1 },
  { code: 'trusted_trips', is_paid: 1, is_available: 1 },
  { code: 'list_ringtones', is_paid: 1, is_available: 1 },
  { code: 'style', is_paid: 1, is_available: 0 },
  { code: 'verified_badge', is_paid: 1, is_available: 1 },
];
const ALL_PAID = CATALOG.map((f) => f.code);

const OFF = { paid_enabled: 0, grace_until: null };
const GRACE = { paid_enabled: 1, grace_until: day(18) };
const PAID = { paid_enabled: 1, grace_until: day(-3) };

// ── Phase ──────────────────────────────────────────────────────────────────
assert.strictEqual(phaseAt(OFF, NOW), 'free');
assert.strictEqual(phaseAt(null, NOW), 'free');
assert.strictEqual(phaseAt(GRACE, NOW), 'grace');
assert.strictEqual(phaseAt(PAID, NOW), 'paid');
assert.strictEqual(phaseAt({ paid_enabled: 1, grace_until: null }, NOW), 'paid');

// ── Chaîne de périodes ─────────────────────────────────────────────────────
{
  const periods = [
    { plan_code: 'plus_mensuel', starts_at: day(-20), ends_at: day(10), source: 0 },
    // renouvelé en avance : commence à la fin de la précédente
    { plan_code: 'plus_mensuel', starts_at: day(10), ends_at: day(40), source: 0 },
  ];
  const r = resolvePeriods(periods, NOW);
  assert.strictEqual(r.current.plan_code, 'plus_mensuel');
  assert.strictEqual(r.chainEnd.toISOString(), day(40).toISOString(), 'la fin de la CHAÎNE');
  assert.strictEqual(r.upcoming.starts_at.toISOString(), day(10).toISOString());
}
{
  // Payé pendant la grâce : la période commence à sa fin, rien n'est en cours.
  const r = resolvePeriods([{ starts_at: day(18), ends_at: day(383) }], NOW);
  assert.strictEqual(r.current, null);
  assert.ok(r.upcoming);
  assert.strictEqual(r.chainEnd, null);
}
assert.deepStrictEqual(resolvePeriods([], NOW), { current: null, upcoming: null, chainEnd: null });

// ── Droits ─────────────────────────────────────────────────────────────────
{
  // Gratuit : tout ce qui est livré est ouvert, le style (non livré) non.
  const e = decideEntitlements({ settings: OFF, catalog: CATALOG, now: NOW });
  assert.strictEqual(e.phase, 'free');
  assert.strictEqual(e.graceUntil, null);
  assert.strictEqual(e.features.translation, true);
  assert.strictEqual(e.features.verified_badge, true);
  assert.strictEqual(e.features.style, false, 'une fonctionnalité non livrée reste fermée');
  assert.strictEqual(e.period, null);
  assert.strictEqual(e.validUntil, day(7).toISOString(), 'une semaine hors ligne au plus');
}
{
  // Grâce : tout reste ouvert, et le téléphone doit revenir à la fin de la grâce.
  const e = decideEntitlements({ settings: GRACE, catalog: CATALOG, now: NOW });
  assert.strictEqual(e.phase, 'grace');
  assert.strictEqual(e.features.backup, true);
  assert.strictEqual(e.graceUntil, day(18).toISOString());
  assert.strictEqual(e.validUntil, day(7).toISOString());
}
{
  // Payant, sans abonnement : fermé.
  const e = decideEntitlements({ settings: PAID, catalog: CATALOG, now: NOW });
  assert.strictEqual(e.phase, 'paid');
  for (const code of ALL_PAID) assert.strictEqual(e.features[code], false, code);
}
{
  // Payant, fonctionnalité rendue gratuite par l'administration : ouverte à tous.
  const catalog = CATALOG.map((f) => (f.code === 'translation' ? { ...f, is_paid: 0 } : f));
  const e = decideEntitlements({ settings: PAID, catalog, now: NOW });
  assert.strictEqual(e.features.translation, true);
  assert.strictEqual(e.features.backup, false);
}
{
  // Payant, abonné : ce que le plan inclut.
  const periods = [{ plan_code: 'plus_annuel', starts_at: day(-3), ends_at: day(362), source: 0 }];
  const e = decideEntitlements({
    settings: PAID, periods, catalog: CATALOG,
    planFeatures: ['translation', 'backup'], autoRenew: true, now: NOW,
  });
  assert.strictEqual(e.features.translation, true);
  assert.strictEqual(e.features.backup, true);
  assert.strictEqual(e.features.trusted_trips, false, 'hors du plan');
  assert.deepStrictEqual(e.period, {
    plan: 'plus_annuel',
    startsAt: day(-3).toISOString(),
    endsAt: day(362).toISOString(),
    source: 0,
    autoRenew: true,
  });
  assert.strictEqual(e.validUntil, day(7).toISOString());
}
{
  // Abonnement qui finit dans deux jours : le téléphone revient à l'échéance.
  const periods = [{ plan_code: 'plus_mensuel', starts_at: day(-28), ends_at: day(2), source: 0 }];
  const e = decideEntitlements({ settings: PAID, periods, catalog: CATALOG, planFeatures: ALL_PAID, now: NOW });
  assert.strictEqual(e.validUntil, day(2).toISOString());
}
{
  // Les droits du plan ne valent que pour une période EN COURS, pas à venir.
  const periods = [{ plan_code: 'plus_annuel', starts_at: day(5), ends_at: day(370), source: 0 }];
  const e = decideEntitlements({ settings: PAID, periods, catalog: CATALOG, planFeatures: ALL_PAID, now: NOW });
  assert.strictEqual(e.features.translation, false);
  assert.strictEqual(e.period, null);
  assert.strictEqual(e.upcoming.plan, 'plus_annuel');
}
{
  // Équipe et compte officiel : exemptés.
  const e = decideEntitlements({ settings: PAID, catalog: CATALOG, exempt: true, now: NOW });
  assert.strictEqual(e.features.trusted_trips, true);
  assert.strictEqual(e.features.style, false, 'même exempté, rien de non livré');
  assert.strictEqual(e.exempt, true);
}

// ── Activation ─────────────────────────────────────────────────────────────
assert.strictEqual(activationBlocker({ NODE_ENV: 'production' }), 'BILLING_PROVIDER_SIMULATED');
assert.strictEqual(activationBlocker({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'simulated' }), 'BILLING_PROVIDER_SIMULATED');
assert.strictEqual(activationBlocker({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'cinetpay' }), null);
assert.strictEqual(activationBlocker({ NODE_ENV: 'development' }), null, 'le simulateur sert aux essais hors production');

// ── Réglages ───────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseSettingsPatch({ trial_days: 0, retention_days: '45' }).value,
  { trial_days: 0, retention_days: 45 });
assert.strictEqual(parseSettingsPatch({ default_grace_days: 6 }).code, 'INVALID_GRACE', '7 jours au moins');
assert.strictEqual(parseSettingsPatch({ default_grace_days: 7 }).ok, true);
assert.strictEqual(parseSettingsPatch({ retention_days: -1 }).code, 'INVALID_BILLING_SETTING');
assert.strictEqual(parseSettingsPatch({}).code, 'NO_FIELDS_TO_UPDATE');

// ── Plans ──────────────────────────────────────────────────────────────────
{
  const ok = parsePlanPayload({
    code: 'plus_trimestriel',
    name_i18n: { fr: 'Trimestriel', en: 'Quarterly', zh: '季度' },
    duration_months: 3, price_amount: 700, reminder_days: 14,
    is_featured: false, features: ['translation', 'backup', 'translation'],
  });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.value.features, ['translation', 'backup'], 'doublons retirés');
  assert.strictEqual(ok.value.is_featured, 0);
}
assert.strictEqual(parsePlanPayload({ code: 'Plus!', name_i18n: { fr: 'a', en: 'b' }, duration_months: 1, price_amount: 1, reminder_days: 1 }).code, 'INVALID_PLAN');
assert.strictEqual(parsePlanPayload({ code: 'plus_x', name_i18n: { fr: 'Seul' }, duration_months: 1, price_amount: 1, reminder_days: 1 }).code, 'INVALID_PLAN', 'en obligatoire');
assert.strictEqual(parsePlanPayload({ code: 'plus_x', name_i18n: { fr: 'a', en: 'b' }, duration_months: 1, price_amount: 250, reminder_days: 30 }).code, 'INVALID_PLAN', 'relance plus longue que le plan');
assert.strictEqual(parsePlanPayload({ code: 'plus_x', name_i18n: { fr: 'a', en: 'b' }, price_amount: 250, reminder_days: 7 }).code, 'INVALID_PLAN', 'durée requise à la création');
assert.strictEqual(parsePlanPayload({ price_amount: 300 }, { partial: true }).ok, true);
assert.strictEqual(parsePlanPayload({ code: 'autre' }, { partial: true }).code, 'FIELD_IMMUTABLE');
assert.strictEqual(parsePlanPayload({}, { partial: true }).code, 'NO_FIELDS_TO_UPDATE');
assert.strictEqual(parsePlanPayload({ price_amount: 2.5 }, { partial: true }).code, 'INVALID_PLAN', 'XAF sans décimales');

// ── Catalogue ──────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseFeaturePatch({ is_paid: false }).value, { is_paid: 0 });
assert.strictEqual(parseFeaturePatch({ is_available: 1 }).code, 'FIELD_IMMUTABLE', 'c\'est le code qui livre');
assert.strictEqual(parseFeaturePatch({}).code, 'NO_FIELDS_TO_UPDATE');

// ── Motif ──────────────────────────────────────────────────────────────────
assert.strictEqual(parseReason({ reason: '  Lancement de l\'offre  ' }).value, 'Lancement de l\'offre');
assert.strictEqual(parseReason({ reason: '' }).code, 'REASON_REQUIRED');
assert.strictEqual(parseReason({}).code, 'REASON_REQUIRED');

console.log('billing rules.test.js OK');
