const express = require('express');
const { paymentWebhook } = require('../controllers/paymentWebhookController');

const router = express.Router();

/**
 * @swagger
 * /api/payments/webhook/{provider}:
 *   post:
 *     summary: Notification d'un fournisseur de paiement
 *     description: >
 *       Sans authentification de session : la signature du fournisseur fait
 *       foi. Tout appel est journalisé (`payment_event`), signature valide ou
 *       non. Une référence inconnue est acquittée (200) pour que le
 *       fournisseur cesse de rejouer.
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ accepted, status }"
 *       401:
 *         description: INVALID_SIGNATURE
 */
router.post('/webhook/:provider', paymentWebhook);

module.exports = router;
