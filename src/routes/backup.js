const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const {
  getCurrentKey,
  getKeyByKid,
  getMeta,
  putMeta,
} = require('../controllers/backupController');

/**
 * Limitation de débit sur les clés.
 *
 * Un compte légitime demande sa clé une fois par sauvegarde et une fois par
 * restauration : quelques appels par jour. Un débit élevé signale autre chose
 * qu'un usage normal, et ce point d'accès est celui dont l'abus coûterait le
 * plus cher — il ouvre le déchiffrement des sauvegardes.
 */
const keyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de demandes de clé', code: 'RATE_LIMITED' },
});

/**
 * @swagger
 * /api/backup/key:
 *   get:
 *     summary: Clé de sauvegarde courante du compte
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ kid, key } — clé en base64, 32 octets"
 *       503:
 *         description: Secret non configuré sur le serveur
 */
router.get('/key', auth, keyLimiter, getCurrentKey);

/**
 * @swagger
 * /api/backup/key/{kid}:
 *   get:
 *     summary: Clé d'une version donnée, pour relire une archive ancienne
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: kid
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: "{ kid, key }"
 *       503:
 *         description: Version inconnue ou secret non configuré
 */
router.get('/key/:kid', auth, keyLimiter, getKeyByKid);

/**
 * @swagger
 * /api/backup/meta:
 *   get:
 *     summary: Ce que le serveur sait de la dernière sauvegarde du compte
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ hasBackup, lastAt, bytes, kid, messageCount, accountHint }"
 *   put:
 *     summary: Déclarer qu'une sauvegarde a réussi (métadonnée seule)
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ ok: true }"
 */
router.get('/meta', auth, getMeta);
router.put('/meta', auth, putMeta);

module.exports = router;
