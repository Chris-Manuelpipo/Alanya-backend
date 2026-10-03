const assert = require('assert');
const {
  phaseAt,
  resolvePeriods,
  decideEntitlements,
  mediaRetentionCovered,
  mediaRetentionDays,
  dueSchedule,
  reminderApplies,
  autoRenewApplies,
  expiryDecision,
  purgeDecision,
  purgeWarningApplies,
  compensationDays,
  effectivePhase,
  activationBlocker,
  purchaseBlocker,
  parseSettingsPatch,
  parsePlanPayload,
  parseFeaturePatch,
  parseReason,
  parsePayUrl,
  billingModel,
  trialEndsAt,
  trialFloor,
  outgoingDecision,
  activationBlockerFor,
  codeSecretBlocker,
  sameInstant,
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
{
  // Abonnement terminé, rien à la suite : l'application dit « terminé le … ».
  const e = decideEntitlements({ settings: PAID, catalog: CATALOG, lastEnd: day(-4), now: NOW });
  assert.strictEqual(e.lapsedAt, day(-4).toISOString());
  // Jamais abonné : rien de terminé.
  assert.strictEqual(decideEntitlements({ settings: PAID, catalog: CATALOG, now: NOW }).lapsedAt, null);
  // En cours ou à venir : pas terminé, même si `lastEnd` traîne.
  const periods = [{ plan_code: 'plus_annuel', starts_at: day(5), ends_at: day(370), source: 0 }];
  assert.strictEqual(
    decideEntitlements({ settings: PAID, periods, catalog: CATALOG, lastEnd: day(-4), now: NOW }).lapsedAt,
    null,
  );
}

// ── Conservation des médias ────────────────────────────────────────────────
{
  const covered = (phase, sub, exempt = false) => mediaRetentionCovered({ phase, exempt, sub, now: NOW });
  const abonne = { current_end: day(30), purge_after: null, purged_at: null };

  // Hors phase payante, personne n'a la durée longue — pas même un abonné.
  assert.strictEqual(covered('free', abonne), false);
  assert.strictEqual(covered('grace', abonne), false);
  assert.strictEqual(covered('free', null, true), false, 'exempté, mais tout le monde est à la durée standard');

  // Phase payante.
  assert.strictEqual(covered('paid', abonne), true);
  assert.strictEqual(covered('paid', null), false, 'jamais abonné');
  assert.strictEqual(covered('paid', { current_end: null, purge_after: null, purged_at: null }), false);
  assert.strictEqual(covered('paid', null, true), true, 'administrateur ou compte officiel');
  // Échu, échéance pas encore traitée : couvert, un jour de trop plutôt qu'un de moins.
  assert.strictEqual(covered('paid', { current_end: day(-1), purge_after: null, purged_at: null }), true);
  // Échu, dans le délai commun avant purge : couvert.
  assert.strictEqual(covered('paid', { current_end: day(-10), purge_after: day(20), purged_at: null }), true);
  // Délai passé, purge des données payantes pas encore faite : plus couvert.
  assert.strictEqual(covered('paid', { current_end: day(-40), purge_after: day(-1), purged_at: null }), false);
  // Données payantes purgées : plus couvert.
  assert.strictEqual(covered('paid', { current_end: day(-40), purge_after: day(-10), purged_at: day(-10) }), false);

  assert.strictEqual(mediaRetentionDays({ covered: true, standardDays: 30, plusDays: 365 }), 365);
  assert.strictEqual(mediaRetentionDays({ covered: false, standardDays: 30, plusDays: 365 }), 30);
  // Mal réglée depuis l'admin, la durée longue ne descend pas sous la standard.
  assert.strictEqual(mediaRetentionDays({ covered: true, standardDays: 60, plusDays: 30 }), 60);

  // Transmise au téléphone avec ses droits.
  const mediaDays = { standardDays: 30, plusDays: 365 };
  assert.strictEqual(decideEntitlements({ settings: OFF, catalog: CATALOG, mediaDays, now: NOW }).mediaRetentionDays, 30);
  const periods = [{ plan_code: 'plus_annuel', starts_at: day(-3), ends_at: day(362), source: 0 }];
  assert.strictEqual(
    decideEntitlements({ settings: PAID, periods, catalog: CATALOG, lastEnd: day(362), mediaDays, now: NOW })
      .mediaRetentionDays,
    365,
  );
  assert.strictEqual(
    decideEntitlements({ settings: PAID, catalog: CATALOG, exempt: true, mediaDays, now: NOW }).mediaRetentionDays,
    365,
  );
  assert.strictEqual(decideEntitlements({ settings: PAID, catalog: CATALOG, mediaDays, now: NOW }).mediaRetentionDays, 30);
  // Sans les durées, le champ reste vide plutôt que d'inventer une valeur.
  assert.strictEqual(decideEntitlements({ settings: PAID, catalog: CATALOG, now: NOW }).mediaRetentionDays, null);
}

// ── Activation ─────────────────────────────────────────────────────────────
assert.strictEqual(activationBlocker({ NODE_ENV: 'production' }), 'BILLING_PROVIDER_SIMULATED');
assert.strictEqual(activationBlocker({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'simulated' }), 'BILLING_PROVIDER_SIMULATED');
assert.strictEqual(activationBlocker({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'cinetpay' }), null);
assert.strictEqual(activationBlocker({ NODE_ENV: 'development' }), null, 'le simulateur sert aux essais hors production');

// Achats hors abonnement : pas d'interrupteur, seulement la règle du simulateur.
{
  const PROD_SIM = { NODE_ENV: 'production', BILLING_TEST_USERS: '11,105' };
  assert.strictEqual(purchaseBlocker(42, PROD_SIM), 'BILLING_PROVIDER_SIMULATED', 'le simulateur n\'encaisse pas en prod');
  assert.strictEqual(purchaseBlocker(105, PROD_SIM), null, 'sauf pour les testeurs');
  assert.strictEqual(purchaseBlocker(42, { ...PROD_SIM, PAYMENT_PROVIDER: 'cinetpay' }), null, 'un vrai fournisseur ouvre la vente à tous');
  assert.strictEqual(purchaseBlocker(42, { NODE_ENV: 'development' }), null);
}

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

// ── Échéances (lot D) ──────────────────────────────────────────────────────
{
  // Jobs d'une fin : relance à fin − 7 j, veille, fin. Relance passée : omise.
  const jobs = dueSchedule({ end: day(30), reminderDays: 7, now: NOW });
  assert.deepStrictEqual(jobs.map((j) => j.kind), ['billing_reminder', 'billing_autorenew', 'billing_expire']);
  assert.strictEqual(jobs[0].at.toISOString(), day(23).toISOString());
  assert.strictEqual(jobs[1].at.toISOString(), day(29).toISOString());
  assert.strictEqual(jobs[2].at.toISOString(), day(30).toISOString());
  const late = dueSchedule({ end: day(3), reminderDays: 7, now: NOW });
  assert.deepStrictEqual(late.map((j) => j.kind), ['billing_autorenew', 'billing_expire'], 'relance passée omise');
}
{
  // Relance : pas en phase gratuite, pas si la fin a bougé depuis.
  const end = day(7);
  assert.strictEqual(reminderApplies({ phase: 'paid', currentEnd: end, jobEnd: end.toISOString(), now: NOW }), true);
  assert.strictEqual(reminderApplies({ phase: 'free', currentEnd: end, jobEnd: end, now: NOW }), false);
  assert.strictEqual(reminderApplies({ phase: 'paid', currentEnd: day(37), jobEnd: end, now: NOW }), false, 'renouvelé');
  const sub = { current_end: end, auto_renew: 1, renew_msisdn: '237699123400', renew_channel: 'orange_money' };
  assert.strictEqual(autoRenewApplies({ phase: 'grace', sub, jobEnd: end, now: NOW }), true);
  assert.strictEqual(autoRenewApplies({ phase: 'paid', sub: { ...sub, auto_renew: 0 }, jobEnd: end, now: NOW }), false);
  assert.strictEqual(autoRenewApplies({ phase: 'paid', sub: { ...sub, renew_msisdn: null }, jobEnd: end, now: NOW }), false);
  assert.strictEqual(autoRenewApplies({ phase: 'free', sub, jobEnd: end, now: NOW }), false, 'suspendu en phase gratuite');
}
{
  // Échéance : purge à fin + rétention, notifiée en phase payante seulement, une fois.
  const sub = { current_end: day(-1), purge_after: null, purged_at: null };
  const d = expiryDecision({ phase: 'paid', sub, now: NOW, retentionDays: 30 });
  assert.strictEqual(d.action, 'expire');
  assert.strictEqual(d.purgeAfter.toISOString(), day(29).toISOString());
  assert.strictEqual(d.notify, true);
  assert.strictEqual(expiryDecision({ phase: 'free', sub, now: NOW }).notify, false);
  assert.strictEqual(expiryDecision({ phase: 'paid', sub: { ...sub, purge_after: day(29) }, now: NOW }).action, 'none', 'déjà traitée');
  assert.strictEqual(expiryDecision({ phase: 'paid', sub: { ...sub, current_end: day(5) }, now: NOW }).action, 'none', 'pas échue');
  // Traitée en retard : le dernier avertissement garde ses sept jours.
  const late = expiryDecision({ phase: 'paid', sub: { ...sub, current_end: day(-40) }, now: NOW, retentionDays: 30 });
  assert.strictEqual(late.purgeAfter.toISOString(), day(7).toISOString());
}
{
  // Purge : en phase payante seulement, reportée sinon ; jamais après un renouvellement.
  const sub = { current_end: day(-31), purge_after: day(-1), purged_at: null };
  assert.strictEqual(purgeDecision({ phase: 'paid', sub, now: NOW }).action, 'purge');
  const p = purgeDecision({ phase: 'grace', sub, now: NOW, retentionDays: 30 });
  assert.strictEqual(p.action, 'postpone');
  assert.strictEqual(p.purgeAfter.toISOString(), day(30).toISOString());
  assert.strictEqual(purgeDecision({ phase: 'paid', sub: { ...sub, current_end: day(20) }, now: NOW }).action, 'none');
  assert.strictEqual(purgeDecision({ phase: 'paid', sub: { ...sub, purged_at: day(-1) }, now: NOW }).action, 'none');
  assert.strictEqual(purgeDecision({ phase: 'paid', sub: { ...sub, purge_after: day(3) }, now: NOW }).action, 'none', 'pas encore');
  assert.strictEqual(
    purgeDecision({ phase: 'free', sub, now: NOW, retentionDays: 0 }).purgeAfter.toISOString(),
    day(1).toISOString(),
    'jamais de report nul',
  );
}
{
  // Dernier avertissement : la purge annoncée tient toujours.
  const sub = { current_end: day(-23), purge_after: day(7), purged_at: null };
  assert.strictEqual(purgeWarningApplies({ phase: 'paid', sub, jobPurgeAfter: day(7).toISOString(), now: NOW }), true);
  assert.strictEqual(purgeWarningApplies({ phase: 'paid', sub, jobPurgeAfter: day(9), now: NOW }), false, 'reportée depuis');
  assert.strictEqual(purgeWarningApplies({ phase: 'grace', sub, jobPurgeAfter: day(7), now: NOW }), false);
}
{
  // Compensation : la durée de la phase gratuite, en jours arrondis au-dessus.
  assert.strictEqual(compensationDays({ deactivatedAt: day(-10), activatedAt: NOW }), 10);
  assert.strictEqual(compensationDays({ deactivatedAt: new Date(NOW.getTime() - 3_600_000), activatedAt: NOW }), 1);
  assert.strictEqual(compensationDays({ deactivatedAt: null, activatedAt: NOW }), 0);
  assert.strictEqual(compensationDays({ deactivatedAt: NOW, activatedAt: day(-1) }), 0);
}
{
  // Données conservées puis effacées : dites seulement quand rien ne court.
  const e = decideEntitlements({ settings: PAID, catalog: CATALOG, lastEnd: day(-4), purgeAfter: day(26), now: NOW });
  assert.strictEqual(e.purgeAfter, day(26).toISOString());
  assert.strictEqual(e.purgedAt, null);
  const periods = [{ plan_code: 'plus_mensuel', starts_at: day(-3), ends_at: day(27), source: 0 }];
  assert.strictEqual(
    decideEntitlements({ settings: PAID, periods, catalog: CATALOG, purgeAfter: day(26), now: NOW }).purgeAfter,
    null,
  );
}
{
  // Un compte testeur est toujours en phase payante.
  assert.strictEqual(effectivePhase(OFF, 12, NOW, { BILLING_TEST_USERS: '12' }), 'paid');
  assert.strictEqual(effectivePhase(OFF, 13, NOW, { BILLING_TEST_USERS: '12' }), 'free');
}

// ── Réglages : lien de paiement et régime ──────────────────────────────────
{
  assert.strictEqual(parsePayUrl('https://pay.alanya237.com/abonnement'), 'https://pay.alanya237.com/abonnement');
  assert.strictEqual(parsePayUrl('  https://pay.alanya237.com  '), 'https://pay.alanya237.com/');
  assert.strictEqual(parsePayUrl(''), null, 'vide : effacé');
  assert.strictEqual(parsePayUrl(null), null);
  assert.strictEqual(parsePayUrl('http://pay.alanya237.com'), undefined, 'https obligatoire');
  assert.strictEqual(parsePayUrl('https://user:pass@pay.alanya237.com'), undefined, 'pas d\'identifiants');
  assert.strictEqual(parsePayUrl('https://pay.alanya237.com/#x'), undefined, 'pas de fragment');
  assert.strictEqual(parsePayUrl('javascript:alert(1)'), undefined);
  assert.strictEqual(parsePayUrl('https://localhost'), undefined, 'un vrai nom de domaine');
  assert.strictEqual(parsePayUrl(`https://a.co/${'x'.repeat(260)}`), undefined, '255 caractères au plus');
  assert.strictEqual(parsePayUrl(42), undefined);

  assert.deepStrictEqual(parseSettingsPatch({ pay_url: 'https://pay.alanya237.com/' }).value, { pay_url: 'https://pay.alanya237.com/' });
  assert.deepStrictEqual(parseSettingsPatch({ pay_url: '' }).value, { pay_url: null });
  assert.strictEqual(parseSettingsPatch({ pay_url: 'ftp://x.com' }).code, 'INVALID_BILLING_SETTING');
  // Le régime ne se règle pas ici : il a son verbe, avec motif.
  assert.strictEqual(parseSettingsPatch({ model: 2 }).code, 'FIELD_IMMUTABLE');
  assert.strictEqual(parseSettingsPatch({ trial_days: 90 }).value.trial_days, 90);
}

// ── sameInstant : la base retire les millisecondes ─────────────────────────
{
  const exact = new Date('2026-10-03T10:00:00.227Z');
  assert.ok(sameInstant(exact, new Date('2026-10-03T10:00:00.000Z')), 'DATETIME tronqué');
  assert.ok(sameInstant(exact, new Date('2026-10-03T10:00:01.000Z')), 'DATETIME arrondi au-dessus');
  assert.ok(!sameInstant(exact, new Date('2026-10-03T10:00:02.000Z')), 'deux secondes : autre instant');
  assert.ok(!sameInstant(exact, null));
  // Une relance posée sur la fin calculée reconnaît la ligne relue en base.
  const jobEnd = new Date('2026-12-01T09:00:00.782Z');
  const stored = new Date('2026-12-01T09:00:00.000Z');
  assert.strictEqual(reminderApplies({ phase: 'paid', currentEnd: stored, jobEnd, now: new Date('2026-11-01T00:00:00Z') }), true);
}

// ── Régime TRIAL (v2) : essai de trois mois, puis réception seule ──────────
{
  // Sans réglage ou régime 1 : Alanya Plus, aucun verrou d'envoi.
  assert.strictEqual(billingModel(null), 1);
  assert.strictEqual(billingModel({ model: 1 }), 1);
  assert.strictEqual(billingModel({ model: 2 }), 2);
  assert.strictEqual(billingModel({ model: 'x' }), 1, 'une valeur inconnue ne verrouille rien');
}
{
  const T = (extra = {}) => ({ model: 2, paid_enabled: 1, grace_until: day(-30), trial_days: 90, ...extra });
  const created = day(-100);

  // Fin d'essai : inscription + trial_days.
  assert.strictEqual(trialEndsAt({ createdAt: created, settings: T() }).toISOString(), day(-10).toISOString());
  assert.strictEqual(trialEndsAt({ createdAt: null, settings: T() }), null);
  // Un compte ancien reçoit la grâce de l'activation : trois mois à partir d'elle.
  assert.strictEqual(
    trialEndsAt({ createdAt: day(-400), settings: T({ grace_until: day(90) }) }).toISOString(),
    day(90).toISOString(),
    'la grâce repousse la fin d\'essai des comptes existants',
  );
  // Un compte récent garde ses trois mois pleins, même si la grâce finit avant.
  assert.strictEqual(
    trialEndsAt({ createdAt: day(-5), settings: T({ grace_until: day(10) }) }).toISOString(),
    day(85).toISOString(),
    'la grâce ne raccourcit jamais l\'essai',
  );
  // Payant éteint : la grâce n'entre pas dans le calcul.
  assert.strictEqual(
    trialEndsAt({ createdAt: day(-5), settings: T({ paid_enabled: 0, grace_until: day(200) }) }).toISOString(),
    day(85).toISOString(),
  );

  // outgoingDecision
  const out = (o) => outgoingDecision({ settings: T(), phase: 'paid', createdAt: created, now: NOW, ...o });
  assert.strictEqual(out({ settings: { ...T(), model: 1 } }).allowed, true, 'régime 1 : jamais de verrou');
  assert.strictEqual(out({ phase: 'free' }).allowed, true, 'payant éteint');
  assert.strictEqual(out({ phase: 'grace' }).allowed, true, 'grâce');
  assert.strictEqual(out({ exempt: true }).allowed, true, 'équipe et compte officiel');
  assert.strictEqual(out({}).allowed, false, 'essai fini, aucune période : réception seule');
  assert.strictEqual(out({ createdAt: day(-50) }).allowed, true, 'en essai');
  assert.strictEqual(out({ createdAt: day(-50) }).until.toISOString(), day(40).toISOString(),
    'le oui vaut jusqu\'à la fin d\'essai');
  assert.strictEqual(out({ coveredUntil: day(200) }).allowed, true, 'une période couvre');
  assert.strictEqual(out({ coveredUntil: day(200) }).until.toISOString(), day(200).toISOString());
  assert.strictEqual(out({ coveredUntil: day(-1) }).allowed, false, 'période échue');
  assert.strictEqual(out({ coveredUntil: NOW }).allowed, false, 'une période qui finit maintenant ne couvre plus');
  // L'instant exact de la fin d'essai : fermé (strict).
  assert.strictEqual(out({ createdAt: day(-90) }).allowed, false, 'à l\'instant de la fin, c\'est fini');

  // trialFloor : nul hors régime TRIAL, nul l'essai fini.
  assert.strictEqual(trialFloor({ settings: { ...T(), model: 1 }, createdAt: day(-5), now: NOW }), null);
  assert.strictEqual(trialFloor({ settings: T(), createdAt: created, now: NOW }), null);
  assert.strictEqual(
    trialFloor({ settings: T(), createdAt: day(-5), now: NOW }).toISOString(),
    day(85).toISOString(),
  );
}
{
  // decideEntitlements, régime TRIAL.
  const T = { model: 2, paid_enabled: 1, grace_until: day(-30), trial_days: 90 };
  const run = (o) => decideEntitlements({
    settings: T, catalog: CATALOG, planFeatures: ALL_PAID, now: NOW, ...o,
  });

  // En essai : tout est ouvert, avec le décompte.
  const inTrial = run({ createdAt: day(-20) });
  assert.strictEqual(inTrial.model, 2);
  assert.strictEqual(inTrial.features.outgoing, true);
  assert.strictEqual(inTrial.features.translation, true, 'les fonctionnalités annexes sont ouvertes pendant l\'essai');
  assert.strictEqual(inTrial.features.backup, true);
  assert.strictEqual(inTrial.trial.active, true);
  assert.strictEqual(inTrial.trial.endsAt, day(70).toISOString());
  assert.strictEqual(inTrial.validUntil, day(7).toISOString(), 'au plus une semaine hors ligne');
  assert.strictEqual(run({ createdAt: day(-88) }).validUntil, day(2).toISOString(),
    'le téléphone relit ses droits à la fin d\'essai');

  // Essai fini, sans abonnement : tout est fermé, sauf recevoir.
  const over = run({ createdAt: day(-200), lastEnd: null });
  assert.strictEqual(over.features.outgoing, false);
  assert.strictEqual(over.features.translation, false);
  assert.strictEqual(over.trial.active, false);
  assert.strictEqual(over.period, null);

  // Essai fini, abonnement en cours : tout est rouvert.
  const periods = [{ plan_code: 'plus_annuel', starts_at: day(-10), ends_at: day(355), source: 4 }];
  const paid = run({ createdAt: day(-200), periods });
  assert.strictEqual(paid.features.outgoing, true);
  assert.strictEqual(paid.features.translation, true);
  assert.strictEqual(paid.period.source, 4);

  // Payé pendant l'essai : la période est « à venir », l'essai continue.
  const early = run({
    createdAt: day(-20),
    periods: [{ plan_code: 'plus_annuel', starts_at: day(70), ends_at: day(435), source: 4 }],
  });
  assert.strictEqual(early.features.outgoing, true);
  assert.strictEqual(early.period, null);
  assert.strictEqual(early.upcoming.startsAt, day(70).toISOString());

  // Payant éteint : aucun décompte, tout est ouvert.
  const off = run({ settings: { ...T, paid_enabled: 0 }, createdAt: day(-200) });
  assert.strictEqual(off.features.outgoing, true);
  assert.strictEqual(off.trial, null);
  // Équipe : jamais soumise à l'offre, aucun décompte.
  const staff = run({ createdAt: day(-200), exempt: true });
  assert.strictEqual(staff.features.outgoing, true);
  assert.strictEqual(staff.trial, null);
  // Régime 1 : rien de nouveau, mais le droit d'émettre est vrai pour tous.
  const plus = decideEntitlements({
    settings: { ...T, model: 1 }, catalog: CATALOG, planFeatures: ALL_PAID, createdAt: day(-200), now: NOW,
  });
  assert.strictEqual(plus.model, 1);
  assert.strictEqual(plus.features.outgoing, true);
  assert.strictEqual(plus.features.translation, false, 'régime 1 : annexes fermées sans abonnement, comme avant');
  assert.strictEqual(plus.trial, null);
}
{
  // Le garde d'activation dépend du régime.
  const prodSim = { NODE_ENV: 'production', PAYMENT_PROVIDER: 'simulated' };
  assert.strictEqual(activationBlockerFor(1, prodSim), 'BILLING_PROVIDER_SIMULATED');
  assert.strictEqual(activationBlockerFor(2, prodSim), 'BILLING_CODE_SECRET_MISSING');
  assert.strictEqual(
    activationBlockerFor(2, { ...prodSim, ACTIVATION_CODE_SECRET: 'x'.repeat(32) }), null,
    'le régime 2 n\'a pas besoin de fournisseur de paiement',
  );
  assert.strictEqual(codeSecretBlocker({ ACTIVATION_CODE_SECRET: 'court' }), 'BILLING_CODE_SECRET_MISSING');
}

console.log('billing rules.test.js OK');
