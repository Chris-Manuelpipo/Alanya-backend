const express = require('express');
const auth = require('../middleware/auth');
const { phoneCheckLimiter } = require('../middleware/rateLimiter');
const {
  getPhoneOffer,
  checkPhone,
  holdPhone,
  releasePhone,
  checkoutPhone,
} = require('../controllers/alanyaPhoneController');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AlanyaPhone
 *   description: >
 *     Le numéro choisi — un numéro Alanya à 8 chiffres, acheté hors
 *     abonnement. Vérifier, mettre de côté, payer. Comme pour l'abonnement,
 *     la réponse de /checkout ne dit jamais « payé » : la confirmation arrive
 *     par `payment:updated`, et le nouveau numéro par `account:phone_changed`.
 */

/**
 * @swagger
 * /api/alanya-phone/offer:
 *   get:
 *     summary: Prix, moyens de paiement, numéro actuel et commande en cours
 *     tags: [AlanyaPhone]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >
 *           { purchasable, price, currency, holdMinutes, provider, currentPhone,
 *           order, credit } — `order` est la commande à reprendre (retenue ou en
 *           paiement), `credit` un changement déjà payé qui attend son numéro.
 */
router.get('/offer', auth, getPhoneOffer);

/**
 * @swagger
 * /api/alanya-phone/check:
 *   get:
 *     summary: Un numéro à 8 chiffres est-il à vendre ?
 *     tags: [AlanyaPhone]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ phone, available, reason: same|taken|set_aside|held|quarantine|null, price, currency }"
 *       400:
 *         description: PHONE_NOT_PURCHASABLE (pas 8 chiffres), INVALID_PHONE_LENGTH, PHONE_NOT_NUMERIC
 *       403:
 *         description: PHONE_PURCHASE_UNAVAILABLE, OFFICIAL_PHONE_FIXED
 */
router.get('/check', auth, phoneCheckLimiter, checkPhone);

/**
 * @swagger
 * /api/alanya-phone/hold:
 *   post:
 *     summary: Mettre un numéro de côté 15 minutes, le temps de payer
 *     tags: [AlanyaPhone]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: >
 *           { order } — ou, s'il restait un changement déjà payé, { applied, credit, phone } :
 *           le numéro est posé sans nouveau paiement.
 *       409:
 *         description: PHONE_UNAVAILABLE (`reason` joint), PHONE_ORDER_PENDING (`orderId`, `paymentId` joints)
 *   delete:
 *     summary: Lever sa mise de côté
 *     tags: [AlanyaPhone]
 *     security:
 *       - bearerAuth: []
 */
router.post('/hold', auth, phoneCheckLimiter, holdPhone);
router.delete('/hold', auth, releasePhone);

/**
 * @swagger
 * /api/alanya-phone/checkout:
 *   post:
 *     summary: Payer le numéro mis de côté (mobile money)
 *     tags: [AlanyaPhone]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: "{ paymentId, status: 'pending', product: 'phone', orderId, phone, amount, currency, provider, nextAction }"
 *       409:
 *         description: PHONE_HOLD_EXPIRED, PAYMENT_PENDING (`paymentId` joint — l'application reprend l'attente)
 */
router.post('/checkout', auth, checkoutPhone);

module.exports = router;
