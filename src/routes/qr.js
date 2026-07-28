const express = require('express');
const router  = express.Router();
const { authCustom } = require('../middleware/authCustom');
const { qrResolveLimiter } = require('../middleware/rateLimiter');
const { getMyQr, regenerateQr, resolveQr } = require('../controllers/qrController');

/**
 * @swagger
 * /api/qr/me:
 *   get:
 *     summary: Mon code QR d'identité (créé au premier appel)
 *     tags: [QR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Jeton opaque et payload à encoder dans le QR
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 qrPublicId:
 *                   type: string
 *                 payload:
 *                   type: string
 */
router.get('/me',             authCustom, getMyQr);

/**
 * @swagger
 * /api/qr/me/regenerate:
 *   post:
 *     summary: Régénère mon code QR d'identité (les QR déjà partagés cessent de résoudre)
 *     tags: [QR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Nouveau jeton opaque et nouveau payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 qrPublicId:
 *                   type: string
 *                 payload:
 *                   type: string
 */
router.post('/me/regenerate', authCustom, regenerateQr);

/**
 * @swagger
 * /api/qr/resolve:
 *   post:
 *     summary: Résout un QR scanné (identité ou session de connexion)
 *     description: >
 *       Le client transmet la chaîne brute scannée ; le parsing et la
 *       résolution sont entièrement côté serveur. Sur un jeton de connexion,
 *       cette route est en lecture seule côté autorisation : elle signale le
 *       scan mais n'approuve jamais et n'émet aucun token.
 *     tags: [QR]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - payload
 *             properties:
 *               payload:
 *                 type: string
 *     responses:
 *       200:
 *         description: >
 *           Contact — { type:'contact', self:true } ou
 *           { type:'contact', added, alreadyContact, contact } ;
 *           connexion — { type:'login', session }
 *       400:
 *         description: Code QR illisible
 *       403:
 *         description: Utilisateur bloqué
 *       404:
 *         description: Jeton inconnu ou expiré
 */
router.post('/resolve',       authCustom, qrResolveLimiter, resolveQr);

module.exports = router;
