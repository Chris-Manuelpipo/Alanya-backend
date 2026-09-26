const { fail, failInternal } = require('../utils/apiError');
const { BillingError } = require('../services/billing/errors');
const purchase = require('../services/alanyaPhonePurchase');

function sendError(res, err, tag) {
  if (err instanceof BillingError) return fail(res, err.status, err.code, err.message, err.extra);
  console.error(`[numero] ${tag} :`, err);
  return failInternal(res);
}

/** GET /api/alanya-phone/offer */
const getPhoneOffer = async (req, res) => {
  try {
    res.json(await purchase.offer(req.user.alanyaID));
  } catch (err) {
    return sendError(res, err, 'offre');
  }
};

/** GET /api/alanya-phone/check?phone= */
const checkPhone = async (req, res) => {
  try {
    res.json(await purchase.check(req.user.alanyaID, req.query.phone));
  } catch (err) {
    return sendError(res, err, 'vérification');
  }
};

/** POST /api/alanya-phone/hold — { phone } */
const holdPhone = async (req, res) => {
  try {
    res.status(201).json(await purchase.hold(req.user.alanyaID, req.body?.phone));
  } catch (err) {
    return sendError(res, err, 'mise de côté');
  }
};

/** DELETE /api/alanya-phone/hold */
const releasePhone = async (req, res) => {
  try {
    res.json(await purchase.release(req.user.alanyaID));
  } catch (err) {
    return sendError(res, err, 'levée de la mise de côté');
  }
};

/** POST /api/alanya-phone/checkout — { orderId, channel, msisdn } */
const checkoutPhone = async (req, res) => {
  const { orderId, channel, msisdn } = req.body || {};
  try {
    res.status(201).json(await purchase.checkout(req.user.alanyaID, { orderId, channel, msisdn }));
  } catch (err) {
    return sendError(res, err, 'demande de paiement');
  }
};

module.exports = {
  getPhoneOffer,
  checkPhone,
  holdPhone,
  releasePhone,
  checkoutPhone,
};
