/**
 * Règles pures de l'abonnement : aucune lecture ni écriture en base.
 *
 * Tout ce qui DÉCIDE vit ici, pour être testé sans MySQL (src/services/billing/
 * rules.test.js, lancé par la CI). Les services qui lisent la base
 * (settings.js, catalog.js, entitlements.js) ne font que rassembler les faits
 * et appeler ces fonctions.
 */

const { PHASE, MIN_GRACE_DAYS, OFFLINE_TRUST_DAYS } = require('../../constants/billing');

const DAY_MS = 86_400_000;

const toDate = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const iso = (v) => toDate(v)?.toISOString() ?? null;

/** La plus proche des dates données (les nulles sont ignorées). */
function earliest(...dates) {
  const valid = dates.map(toDate).filter(Boolean);
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

/**
 * Phase du payant à l'instant `now`.
 * Interrupteur éteint : gratuit. Allumé : grâce jusqu'à `grace_until`, payant
 * ensuite.
 */
function phaseAt(settings, now = new Date()) {
  if (!settings || Number(settings.paid_enabled) !== 1) return PHASE.FREE;
  const graceUntil = toDate(settings.grace_until);
  if (graceUntil && now < graceUntil) return PHASE.GRACE;
  return PHASE.PAID;
}

/**
 * Période en cours, fin de la chaîne de périodes contiguës, première période
 * à venir.
 *
 * Renouveler en avance crée une période qui commence à la fin de la
 * précédente : pour l'utilisateur, l'abonnement court jusqu'à la fin de la
 * CHAÎNE, pas de la période en cours. Une période payée pendant la grâce
 * commence à sa fin : elle est « à venir ».
 *
 * @param {Array<{starts_at, ends_at}>} periods toutes celles qui finissent après `now`
 */
function resolvePeriods(periods, now = new Date()) {
  const sorted = [...(periods || [])]
    .map((p) => ({ ...p, _s: toDate(p.starts_at), _e: toDate(p.ends_at) }))
    .filter((p) => p._s && p._e && p._e > now)
    .sort((a, b) => a._s - b._s);

  const current = sorted.find((p) => p._s <= now) || null;
  const upcoming = sorted.find((p) => p._s > now) || null;

  let chainEnd = null;
  if (current) {
    chainEnd = current._e;
    for (const p of sorted) {
      if (p._s <= chainEnd && p._e > chainEnd) chainEnd = p._e;
    }
  }

  const strip = (p) => {
    if (!p) return null;
    const { _s, _e, ...rest } = p;
    return rest;
  };
  return { current: strip(current), upcoming: strip(upcoming), chainEnd };
}

/**
 * Le cœur : les droits d'un compte, à partir des faits.
 *
 * Une fonctionnalité est ouverte si elle est livrée ET (gratuite, ou hors
 * phase payante, ou compte exempté, ou incluse dans le plan de la période en
 * cours). La coche (`verified_badge`) est une fonctionnalité comme une autre :
 * son affichage demande EN PLUS une identité vérifiée, ce que décide la
 * vérification (lot E), pas ce calcul.
 *
 * @param {object} p
 * @param {object} p.settings          ligne billing_settings
 * @param {Array}  p.periods           périodes qui finissent après `now`, avec `plan_code`, `source`
 * @param {Array<{code, is_paid, is_available}>} p.catalog
 * @param {string[]} [p.planFeatures]  codes inclus dans le plan de la période en cours
 * @param {boolean}  [p.exempt]        administrateur ou compte officiel
 * @param {boolean}  [p.autoRenew]
 * @param {Date}     [p.now]
 */
function decideEntitlements({
  settings,
  periods = [],
  catalog = [],
  planFeatures = [],
  exempt = false,
  autoRenew = false,
  now = new Date(),
}) {
  const phase = phaseAt(settings, now);
  const { current, upcoming, chainEnd } = resolvePeriods(periods, now);
  const included = current ? planFeatures : [];

  const features = {};
  for (const f of catalog) {
    const available = Number(f.is_available) === 1;
    features[f.code] = available && (
      Number(f.is_paid) === 0
      || phase !== PHASE.PAID
      || exempt
      || included.includes(f.code)
    );
  }

  const graceUntil = phase === PHASE.GRACE ? toDate(settings.grace_until) : null;
  const describe = (p, endsAt) => (p
    ? {
      plan: p.plan_code ?? null,
      startsAt: iso(p.starts_at),
      endsAt: iso(endsAt ?? p.ends_at),
      source: Number(p.source) || 0,
      autoRenew: Boolean(autoRenew),
    }
    : null);

  return {
    phase,
    graceUntil: iso(graceUntil),
    period: describe(current, chainEnd),
    upcoming: describe(upcoming),
    exempt: Boolean(exempt),
    features,
    // Au-delà, le téléphone doit redemander ses droits : la fin de
    // l'abonnement, la fin de la grâce, ou une semaine au plus.
    validUntil: iso(earliest(chainEnd, graceUntil, new Date(now.getTime() + OFFLINE_TRUST_DAYS * DAY_MS))),
  };
}

/** Fournisseur de paiement actif (variable d'environnement, secrets à côté). */
function paymentProvider(env = process.env) {
  return String(env.PAYMENT_PROVIDER || 'simulated').trim().toLowerCase();
}

/**
 * Ce qui empêche d'activer le payant, ou null.
 * En production, le simulateur ne doit jamais encaisser : tant qu'il est le
 * fournisseur actif, n'importe qui obtiendrait un abonnement réel avec un
 * paiement fictif.
 */
function activationBlocker(env = process.env) {
  if (env.NODE_ENV === 'production' && paymentProvider(env) === 'simulated') {
    return 'BILLING_PROVIDER_SIMULATED';
  }
  return null;
}

/** Entier strict : nombre entier, ou chaîne de chiffres. */
function toStrictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

const bad = (code, error) => ({ ok: false, code, error });

/** Réglages modifiables par PUT /admin/billing/settings. */
function parseSettingsPatch(body) {
  const src = body || {};
  const value = {};
  const bounds = {
    default_grace_days: [MIN_GRACE_DAYS, 365],
    trial_days: [0, 365],
    retention_days: [0, 365],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (src[key] === undefined) continue;
    const n = toStrictInt(src[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return bad(key === 'default_grace_days' ? 'INVALID_GRACE' : 'INVALID_BILLING_SETTING',
        `${key} doit être un entier entre ${min} et ${max}`);
    }
    value[key] = n;
  }
  if (!Object.keys(value).length) return bad('NO_FIELDS_TO_UPDATE', 'Aucune modification');
  return { ok: true, value };
}

const PLAN_CODE_RE = /^[a-z0-9_]{3,40}$/;
const LOCALES = ['fr', 'en', 'zh'];
const REQUIRED_LOCALES = ['fr', 'en'];

/** Nom ou description multilingue : fr et en obligatoires (si `required`). */
function parseI18n(v, { required, max }) {
  if (v == null) return required ? null : undefined;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const lang of LOCALES) {
    if (v[lang] == null || v[lang] === '') continue;
    if (typeof v[lang] !== 'string' || v[lang].trim().length > max) return null;
    out[lang] = v[lang].trim();
  }
  if (required && REQUIRED_LOCALES.some((l) => !out[l])) return null;
  return out;
}

/**
 * Corps de POST /admin/billing/plans (création) et PUT /admin/billing/plans/:id
 * (modification, `partial`). Le code d'un plan ne change jamais : il sert de
 * référence stable aux produits des stores et au journal.
 */
function parsePlanPayload(body, { partial = false } = {}) {
  const src = body || {};
  const value = {};

  if (!partial) {
    if (typeof src.code !== 'string' || !PLAN_CODE_RE.test(src.code)) {
      return bad('INVALID_PLAN', 'code : 3 à 40 caractères parmi a-z, 0-9 et _');
    }
    value.code = src.code;
  } else if (src.code !== undefined) {
    return bad('FIELD_IMMUTABLE', 'Le code d\'un plan ne se modifie pas');
  }

  if (!partial || src.name_i18n !== undefined) {
    const name = parseI18n(src.name_i18n, { required: true, max: 60 });
    if (!name) return bad('INVALID_PLAN', 'name_i18n : fr et en obligatoires, 60 caractères au plus');
    value.name_i18n = name;
  }

  const ints = {
    duration_months: [1, 36],
    price_amount: [0, 10_000_000],
    reminder_days: [0, 90],
    sort_order: [0, 10_000],
  };
  for (const [key, [min, max]] of Object.entries(ints)) {
    if (src[key] === undefined) {
      if (!partial && key !== 'sort_order') return bad('INVALID_PLAN', `${key} requis`);
      continue;
    }
    const n = toStrictInt(src[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return bad('INVALID_PLAN', `${key} doit être un entier entre ${min} et ${max}`);
    }
    value[key] = n;
  }

  // Une relance ne peut pas précéder le début de la période : « 30 jours
  // avant » n'a pas de sens pour un plan d'un mois.
  if (value.reminder_days !== undefined && value.duration_months !== undefined
      && value.reminder_days >= value.duration_months * 28) {
    return bad('INVALID_PLAN', 'reminder_days doit être plus court que la durée du plan');
  }

  if (src.currency !== undefined) {
    if (typeof src.currency !== 'string' || !/^[A-Z]{3}$/.test(src.currency)) {
      return bad('INVALID_PLAN', 'currency : code ISO 4217 en trois lettres');
    }
    value.currency = src.currency;
  }

  for (const key of ['is_active', 'is_featured']) {
    if (src[key] === undefined) continue;
    if (typeof src[key] !== 'boolean' && src[key] !== 0 && src[key] !== 1) {
      return bad('INVALID_PLAN', `${key} doit être un booléen`);
    }
    value[key] = src[key] ? 1 : 0;
  }

  for (const key of ['store_product_ios', 'store_product_android']) {
    if (src[key] === undefined) continue;
    if (src[key] === null || src[key] === '') { value[key] = null; continue; }
    if (typeof src[key] !== 'string' || src[key].trim().length > 100) {
      return bad('INVALID_PLAN', `${key} : 100 caractères au plus`);
    }
    value[key] = src[key].trim();
  }

  if (src.features !== undefined) {
    if (!Array.isArray(src.features) || src.features.some((c) => typeof c !== 'string')) {
      return bad('INVALID_PLAN', 'features : liste de codes de fonctionnalité');
    }
    value.features = [...new Set(src.features)];
  }

  if (partial && !Object.keys(value).length) return bad('NO_FIELDS_TO_UPDATE', 'Aucune modification');
  return { ok: true, value };
}

/** Corps de PUT /admin/billing/features/:code. `is_available` n'y est pas : c'est le code qui livre. */
function parseFeaturePatch(body) {
  const src = body || {};
  const value = {};
  if (src.is_available !== undefined) {
    return bad('FIELD_IMMUTABLE', 'is_available suit le code livré, il ne se règle pas');
  }
  if (src.is_paid !== undefined) {
    if (typeof src.is_paid !== 'boolean' && src.is_paid !== 0 && src.is_paid !== 1) {
      return bad('INVALID_FEATURE', 'is_paid doit être un booléen');
    }
    value.is_paid = src.is_paid ? 1 : 0;
  }
  if (src.name_i18n !== undefined) {
    const name = parseI18n(src.name_i18n, { required: true, max: 60 });
    if (!name) return bad('INVALID_FEATURE', 'name_i18n : fr et en obligatoires');
    value.name_i18n = name;
  }
  if (src.description_i18n !== undefined) {
    const desc = parseI18n(src.description_i18n, { required: false, max: 160 });
    if (desc === null) return bad('INVALID_FEATURE', 'description_i18n : 160 caractères au plus');
    value.description_i18n = desc ?? null;
  }
  if (src.sort_order !== undefined) {
    const n = toStrictInt(src.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return bad('INVALID_FEATURE', 'sort_order invalide');
    value.sort_order = n;
  }
  if (!Object.keys(value).length) return bad('NO_FIELDS_TO_UPDATE', 'Aucune modification');
  return { ok: true, value };
}

/** Motif obligatoire des transitions de l'interrupteur (journalisé par adminAudit). */
function parseReason(body) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) return bad('REASON_REQUIRED', 'Motif obligatoire');
  return { ok: true, value: reason.slice(0, 500) };
}

/**
 * Comptes testeurs (BILLING_TEST_USERS=12,34) : ils voient la phase payante
 * même interrupteur éteint, et peuvent acheter. C'est ainsi qu'on éprouve le
 * parcours complet en production sans toucher personne d'autre.
 */
function billingTesterIds(env = process.env) {
  return new Set(
    String(env.BILLING_TEST_USERS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

function isBillingTester(alanyaID, env = process.env) {
  return billingTesterIds(env).has(Number(alanyaID));
}

module.exports = {
  DAY_MS,
  billingTesterIds,
  isBillingTester,
  earliest,
  phaseAt,
  resolvePeriods,
  decideEntitlements,
  paymentProvider,
  activationBlocker,
  parseSettingsPatch,
  parsePlanPayload,
  parseFeaturePatch,
  parseReason,
};
