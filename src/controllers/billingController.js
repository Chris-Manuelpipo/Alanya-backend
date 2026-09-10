const pool = require('../config/db');
const { fail, failInternal } = require('../utils/apiError');
const { BillingError } = require('../services/billing/errors');
const { entitlementsFor } = require('../services/billing/entitlements');
const { listPlans, listFeatures } = require('../services/billing/catalog');
const payments = require('../services/payments/paymentService');
const providers = require('../services/payments/providers');
const { PAYMENT_STATUS_NAME } = require('../services/payments/paymentRules');

function sendError(res, err, tag) {
  if (err instanceof BillingError) return fail(res, err.status, err.code, err.message, err.extra);
  console.error(`[billing] ${tag} :`, err);
  return failInternal(res);
}

/**
 * GET /api/billing/me — les droits du compte connecté.
 *
 * La même charge utile voyage dans /auth/me ; cette route sert au
 * rafraîchissement ciblé (retour au premier plan, `validUntil` échu,
 * événement `entitlements:updated`) sans relire tout le profil.
 */
const getMyEntitlements = async (req, res) => {
  try {
    res.json(await entitlementsFor(req.user.alanyaID));
  } catch (err) {
    return sendError(res, err, 'droits du compte');
  }
};

/** GET /api/billing/offer — tout ce que l'écran d'offre affiche, en un appel. */
const getOffer = async (req, res) => {
  try {
    const [plans, features, entitlements] = await Promise.all([
      listPlans({ activeOnly: true }),
      listFeatures(),
      entitlementsFor(req.user.alanyaID),
    ]);
    let provider = null;
    try {
      const p = providers.active();
      provider = { name: p.name, channels: p.channels, simulated: p.name === 'simulated' };
    } catch {
      provider = null;
    }
    res.json({
      phase: entitlements.phase,
      graceUntil: entitlements.graceUntil,
      purchasable: entitlements.phase !== 'free' && provider != null,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name_i18n,
        durationMonths: Number(p.duration_months),
        price: Number(p.price_amount),
        currency: p.currency,
        featured: Number(p.is_featured) === 1,
        features: p.features,
      })),
      features: features
        .filter((f) => f.is_available === 1 && f.is_paid === 1)
        .map((f) => ({ code: f.code, name: f.name_i18n, description: f.description_i18n })),
      provider,
      entitlements,
    });
  } catch (err) {
    return sendError(res, err, 'offre');
  }
};

/** POST /api/billing/checkout — { planCode, channel, msisdn, autoRenew? } */
const postCheckout = async (req, res) => {
  const { planCode, channel, msisdn, autoRenew } = req.body || {};
  try {
    const result = await payments.checkout({
      alanyaID: req.user.alanyaID,
      planCode,
      channel,
      msisdn,
      autoRenew: typeof autoRenew === 'boolean' ? autoRenew : undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    return sendError(res, err, 'demande de paiement');
  }
};

/** GET /api/billing/payments/:id — le statut d'un paiement du compte. */
const getPayment = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Paiement introuvable');
  try {
    const [[p]] = await pool.execute(
      `SELECT p.id, p.status, p.amount, p.currency, p.channel, p.failure_code,
              p.created_at, p.confirmed_at, pl.code AS plan_code
         FROM payment p JOIN plan pl ON pl.id = p.plan_id
        WHERE p.id = ? AND p.alanyaID = ?`,
      [id, req.user.alanyaID],
    );
    if (!p) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Paiement introuvable');
    res.json({
      id: p.id,
      status: PAYMENT_STATUS_NAME[p.status],
      plan: p.plan_code,
      amount: Number(p.amount),
      currency: p.currency,
      channel: p.channel,
      failureCode: p.failure_code,
      createdAt: p.created_at,
      confirmedAt: p.confirmed_at,
    });
  } catch (err) {
    return sendError(res, err, 'statut de paiement');
  }
};

/** GET /api/billing/history — périodes et paiements du compte, les plus récents d'abord. */
const getHistory = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [periods] = await pool.execute(
      `SELECT sp.starts_at, sp.ends_at, sp.source, pl.code AS plan_code
         FROM subscription_period sp JOIN plan pl ON pl.id = sp.plan_id
        WHERE sp.alanyaID = ? ORDER BY sp.starts_at DESC LIMIT 50`,
      [alanyaID],
    );
    const [rows] = await pool.execute(
      `SELECT p.id, p.status, p.amount, p.currency, p.channel, p.created_at, pl.code AS plan_code
         FROM payment p JOIN plan pl ON pl.id = p.plan_id
        WHERE p.alanyaID = ? ORDER BY p.id DESC LIMIT 50`,
      [alanyaID],
    );
    res.json({
      periods: periods.map((p) => ({
        plan: p.plan_code, startsAt: p.starts_at, endsAt: p.ends_at, source: Number(p.source),
      })),
      payments: rows.map((p) => ({
        id: p.id, status: PAYMENT_STATUS_NAME[p.status], plan: p.plan_code,
        amount: Number(p.amount), currency: p.currency, channel: p.channel, createdAt: p.created_at,
      })),
    });
  } catch (err) {
    return sendError(res, err, 'historique');
  }
};

/** PUT /api/billing/preferences — { autoRenew?, renewPlanCode? } */
const putPreferences = async (req, res) => {
  const { autoRenew, renewPlanCode } = req.body || {};
  if (autoRenew === undefined && renewPlanCode === undefined) {
    return fail(res, 400, 'NO_FIELDS_TO_UPDATE', 'Aucune modification');
  }
  if (autoRenew !== undefined && typeof autoRenew !== 'boolean') {
    return fail(res, 400, 'INVALID_PREFERENCES', 'autoRenew doit être un booléen');
  }
  try {
    let planId = null;
    if (renewPlanCode !== undefined) {
      const [[plan]] = await pool.execute('SELECT id FROM plan WHERE code = ? AND is_active = 1', [String(renewPlanCode)]);
      if (!plan) return fail(res, 404, 'PLAN_NOT_FOUND', 'Plan introuvable');
      planId = plan.id;
    }
    const alanyaID = req.user.alanyaID;
    await pool.execute('INSERT IGNORE INTO subscriber (alanyaID) VALUES (?)', [alanyaID]);
    if (autoRenew !== undefined) {
      await pool.execute('UPDATE subscriber SET auto_renew = ? WHERE alanyaID = ?', [autoRenew ? 1 : 0, alanyaID]);
    }
    if (planId != null) {
      await pool.execute('UPDATE subscriber SET renew_plan_id = ? WHERE alanyaID = ?', [planId, alanyaID]);
    }
    res.json(await entitlementsFor(alanyaID));
  } catch (err) {
    return sendError(res, err, 'préférences');
  }
};

module.exports = {
  getMyEntitlements,
  getOffer,
  postCheckout,
  getPayment,
  getHistory,
  putPreferences,
};
