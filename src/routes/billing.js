const express = require('express');
const auth = require('../middleware/auth');
const {
  getMyEntitlements,
  getOffer,
  postCheckout,
  getPayment,
  getHistory,
  putPreferences,
} = require('../controllers/billingController');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: >
 *     Abonnement Alanya Plus — droits d'accès, offre, paiement mobile money.
 *     Le paiement n'est jamais confirmé par la réponse de /checkout : il l'est
 *     quand le fournisseur prévient le serveur, ce que l'application apprend
 *     par l'événement socket `payment:updated`.
 */

/**
 * @swagger
 * /api/billing/me:
 *   get:
 *     summary: Droits d'accès du compte connecté
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >
 *           Phase du payant (free, grace, paid), période en cours ou à venir,
 *           fonctionnalités ouvertes, et `validUntil` — jusqu'à quand le
 *           téléphone peut se fier à cette réponse sans réseau.
 */
router.get('/me', auth, getMyEntitlements);

/**
 * @swagger
 * /api/billing/offer:
 *   get:
 *     summary: Plans, fonctionnalités, moyens de paiement et droits actuels
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 */
router.get('/offer', auth, getOffer);

/**
 * @swagger
 * /api/billing/checkout:
 *   post:
 *     summary: Demander un paiement mobile money
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: "{ paymentId, status: 'pending', plan, amount, currency, provider, nextAction }"
 *       409:
 *         description: BILLING_NOT_ACTIVE, ou PAYMENT_PENDING (un paiement attend déjà)
 */
router.post('/checkout', auth, postCheckout);

/**
 * @swagger
 * /api/billing/payments/{id}:
 *   get:
 *     summary: Statut d'un paiement du compte
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 */
router.get('/payments/:id', auth, getPayment);

/**
 * @swagger
 * /api/billing/history:
 *   get:
 *     summary: Périodes et paiements du compte
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 */
router.get('/history', auth, getHistory);

/**
 * @swagger
 * /api/billing/preferences:
 *   put:
 *     summary: Renouvellement automatique, durée du prochain renouvellement
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 */
router.put('/preferences', auth, putPreferences);

module.exports = router;
