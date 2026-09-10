const express = require('express');
const auth = require('../middleware/auth');
const { getMyEntitlements } = require('../controllers/billingController');

const router = express.Router();

/**
 * @swagger
 * /api/billing/me:
 *   get:
 *     summary: Droits d'accès du compte connecté (abonnement Alanya Plus)
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

module.exports = router;
