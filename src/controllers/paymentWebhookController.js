const { fail, failInternal } = require('../utils/apiError');
const { BillingError } = require('../services/billing/errors');
const { handleWebhook } = require('../services/payments/paymentService');

/**
 * POST /api/payments/webhook/:provider
 *
 * Sans session : la signature du fournisseur fait foi, vérifiée sur le corps
 * BRUT (`req.rawBody`, capturé par express.json dans server.js) — un corps
 * re-sérialisé ne donnerait pas la même signature.
 */
const paymentWebhook = async (req, res) => {
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  try {
    res.json(await handleWebhook(req.params.provider, { headers: req.headers, rawBody }));
  } catch (err) {
    if (err instanceof BillingError) return fail(res, err.status, err.code, err.message);
    console.error('[paiement] webhook :', err);
    return failInternal(res);
  }
};

module.exports = { paymentWebhook };
