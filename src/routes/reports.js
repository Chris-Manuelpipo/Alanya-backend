const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { messageLimiter } = require('../middleware/rateLimiter');
const { postReport, getReportReasons } = require('../controllers/reportController');

/**
 * @swagger
 * /api/reports/reasons:
 *   get:
 *     summary: Motifs de signalement acceptés
 *     tags: [Signalements]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des clés de motif
 */
router.get('/reasons', auth, getReportReasons);

/**
 * @swagger
 * /api/reports:
 *   post:
 *     summary: Signaler un message ou un compte
 *     tags: [Signalements]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetType, targetId, reason]
 *             properties:
 *               targetType:
 *                 type: string
 *                 enum: [message, user]
 *               targetId:
 *                 type: integer
 *               reason:
 *                 type: string
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: Signalement enregistré (`duplicate` si déjà signalé)
 *       400:
 *         description: Cible, motif ou identifiant invalide
 *       404:
 *         description: Message introuvable
 */
// `messageLimiter` plutôt qu'un plafond dédié : signaler suit le même rythme
// humain qu'écrire, et un motif de plus n'ouvre pas une surface d'abus
// différente de l'envoi de messages.
router.post('/', auth, messageLimiter, postReport);

module.exports = router;
