/**
 * Administration de l'abonnement Alanya Plus : l'interrupteur, ses réglages,
 * les plans et le catalogue des fonctionnalités.
 *
 * Les transitions de l'interrupteur (activer, désactiver, prolonger la grâce)
 * exigent un motif : `adminAudit` le recopie dans le journal, avec le verbe de
 * la route. Aucune ne passe par un PUT générique.
 */

const pool = require('../../config/db');
const { fail, failInternal } = require('../../utils/apiError');
const { BillingError } = require('../../services/billing/errors');
const settings = require('../../services/billing/settings');
const catalog = require('../../services/billing/catalog');
const {
  phaseAt,
  activationBlocker,
  paymentProvider,
  parseSettingsPatch,
  parsePlanPayload,
  parseFeaturePatch,
  parseReason,
} = require('../../services/billing/rules');
const { ACCOUNT_TYPE, VERIFICATION } = require('../../constants/accountTypes');

/** Refus métier → code stable ; le reste → INTERNAL, détail au journal. */
function sendError(res, err, tag) {
  if (err instanceof BillingError) return fail(res, err.status, err.code, err.message);
  console.error(`[admin/billing] ${tag} :`, err);
  return failInternal(res);
}

function reject(res, parsed) {
  return fail(res, 400, parsed.code, parsed.error);
}

/**
 * Ce que l'activation déclencherait aujourd'hui : combien de comptes recevront
 * l'annonce, combien de coches entreront en grâce. L'administrateur voit ces
 * chiffres avant de décider.
 */
async function activationPreview() {
  const [[row]] = await pool.execute(
    `SELECT
       SUM(account_type <> ?)                              AS accounts,
       SUM(account_type = ? AND verification_status = ?)   AS verified_badges
     FROM users WHERE exclus = 0`,
    [ACCOUNT_TYPE.OFFICIEL, ACCOUNT_TYPE.PERSONNEL, VERIFICATION.VERIFIE],
  );
  return {
    accounts: Number(row?.accounts) || 0,
    verifiedBadges: Number(row?.verified_badges) || 0,
  };
}

async function settingsPayload() {
  const s = await settings.getBillingSettings();
  return {
    settings: s,
    phase: phaseAt(s),
    provider: paymentProvider(),
    activationBlockedBy: activationBlocker(),
    preview: await activationPreview(),
  };
}

const getBillingSettings = async (req, res) => {
  try {
    res.json(await settingsPayload());
  } catch (err) {
    return sendError(res, err, 'lecture des réglages');
  }
};

const updateBillingSettings = async (req, res) => {
  const parsed = parseSettingsPatch(req.body);
  if (!parsed.ok) return reject(res, parsed);
  try {
    await settings.updateSettings(parsed.value, req.user.alanyaID);
    res.json(await settingsPayload());
  } catch (err) {
    return sendError(res, err, 'réglages');
  }
};

const activateBilling = async (req, res) => {
  const reason = parseReason(req.body);
  if (!reason.ok) return reject(res, reason);
  let graceDays;
  if (req.body?.graceDays !== undefined) {
    graceDays = Number(req.body.graceDays);
    if (!Number.isInteger(graceDays)) return fail(res, 400, 'INVALID_GRACE', 'graceDays doit être un entier');
  }
  try {
    await settings.activate({ graceDays, adminId: req.user.alanyaID });
    res.json(await settingsPayload());
  } catch (err) {
    return sendError(res, err, 'activation');
  }
};

const deactivateBilling = async (req, res) => {
  const reason = parseReason(req.body);
  if (!reason.ok) return reject(res, reason);
  try {
    await settings.deactivate({ adminId: req.user.alanyaID });
    res.json(await settingsPayload());
  } catch (err) {
    return sendError(res, err, 'désactivation');
  }
};

const extendBillingGrace = async (req, res) => {
  const reason = parseReason(req.body);
  if (!reason.ok) return reject(res, reason);
  if (!req.body?.graceUntil) return fail(res, 400, 'INVALID_GRACE', 'graceUntil requis');
  try {
    await settings.extendGrace({ graceUntil: req.body.graceUntil, adminId: req.user.alanyaID });
    res.json(await settingsPayload());
  } catch (err) {
    return sendError(res, err, 'prolongation de la grâce');
  }
};

const listBillingPlans = async (req, res) => {
  try {
    res.json({ plans: await catalog.listPlans() });
  } catch (err) {
    return sendError(res, err, 'liste des plans');
  }
};

const createBillingPlan = async (req, res) => {
  const parsed = parsePlanPayload(req.body);
  if (!parsed.ok) return reject(res, parsed);
  try {
    const id = await catalog.createPlan(parsed.value, req.user.alanyaID);
    const plans = await catalog.listPlans();
    res.status(201).json({ plan: plans.find((p) => p.id === id) ?? null });
  } catch (err) {
    return sendError(res, err, 'création de plan');
  }
};

const updateBillingPlan = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 404, 'PLAN_NOT_FOUND', 'Plan introuvable');
  const parsed = parsePlanPayload(req.body, { partial: true });
  if (!parsed.ok) return reject(res, parsed);
  try {
    await catalog.updatePlan(id, parsed.value, req.user.alanyaID);
    const plans = await catalog.listPlans();
    res.json({ plan: plans.find((p) => p.id === id) ?? null });
  } catch (err) {
    return sendError(res, err, 'modification de plan');
  }
};

const listBillingFeatures = async (req, res) => {
  try {
    res.json({ features: await catalog.listFeatures() });
  } catch (err) {
    return sendError(res, err, 'catalogue');
  }
};

const updateBillingFeature = async (req, res) => {
  const parsed = parseFeaturePatch(req.body);
  if (!parsed.ok) return reject(res, parsed);
  try {
    await catalog.updateFeature(req.params.code, parsed.value);
    res.json({ features: await catalog.listFeatures() });
  } catch (err) {
    return sendError(res, err, 'fonctionnalité');
  }
};

module.exports = {
  getBillingSettings,
  updateBillingSettings,
  activateBilling,
  deactivateBilling,
  extendBillingGrace,
  listBillingPlans,
  createBillingPlan,
  updateBillingPlan,
  listBillingFeatures,
  updateBillingFeature,
};
