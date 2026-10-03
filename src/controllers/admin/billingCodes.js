/**
 * Administration des codes d'activation : en générer un lot (tests, ventes
 * manuelles), les lister, en annuler un.
 *
 * Les codes en clair n'existent que dans la réponse de la génération : la base
 * n'en garde que l'empreinte. Cette réponse n'est donc jamais mise en cache, et
 * le journal d'audit ne recopie que le motif — jamais le corps ni la réponse.
 */

const { fail, failInternal } = require('../../utils/apiError');
const { BillingError } = require('../../services/billing/errors');
const codes = require('../../services/billing/activationCodes');
const { getPlan } = require('../../services/billing/catalog');

function sendError(res, err, tag) {
  if (err instanceof BillingError) return fail(res, err.status, err.code, err.message);
  console.error(`[admin/billing-codes] ${tag} :`, err);
  return failInternal(res);
}

/** Entier strict, ou NaN : « 3 » et 3 passent, « 3.5 » et « abc » non. */
const toInt = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
};

/**
 * POST /admin/billing/codes — { count, label?, validity_days?, amount_paid? }
 *
 * Répond 201 avec les codes en clair, une seule fois.
 */
const generateBillingCodes = async (req, res) => {
  const body = req.body || {};
  const count = toInt(body.count);
  const validityDays = body.validity_days === undefined ? codes.DEFAULT_VALIDITY_DAYS : toInt(body.validity_days);
  const amountPaid = body.amount_paid === undefined ? 0 : toInt(body.amount_paid);
  try {
    const made = await codes.issueBatch({
      count, label: body.label, adminId: req.user.alanyaID, validityDays, amountPaid,
    });
    const sale = await codes.getSalePlan();
    const plan = sale ? await getPlan(sale.id) : null;
    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      codes: made.map((m) => ({ id: m.id, code: m.code, hint: m.hint })),
      plan: plan && {
        code: plan.code,
        durationMonths: Number(plan.duration_months),
        price: Number(plan.price_amount),
        currency: plan.currency,
      },
      expiresAt: new Date(Date.now() + validityDays * 86_400_000).toISOString(),
    });
  } catch (err) {
    return sendError(res, err, 'génération');
  }
};

/** GET /admin/billing/codes?status=&search=&limit=&offset= */
const listBillingCodes = async (req, res) => {
  try {
    res.json(await codes.listCodes({
      status: req.query.status || null,
      search: req.query.search || null,
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    return sendError(res, err, 'liste');
  }
};

/** POST /admin/billing/codes/:id/revoke — { reason } */
const revokeBillingCode = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 404, 'CODE_NOT_FOUND', 'Code introuvable');
  try {
    await codes.revokeCode({ id, adminId: req.user.alanyaID, reason: req.body?.reason });
    res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'révocation');
  }
};

module.exports = { generateBillingCodes, listBillingCodes, revokeBillingCode };
