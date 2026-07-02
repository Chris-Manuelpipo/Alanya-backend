const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const { uploadMedia, getMedia } = require('../controllers/mediaController');
const { uploadEncryptedBlob }   = require('../middleware/mediaUpload');
const { handleMulterError }     = require('../middleware/upload');
const { uploadLimiter }         = require('../middleware/rateLimiter');

/**
 * @swagger
 * /api/media/upload:
 *   post:
 *     summary: Uploader un blob média déjà chiffré côté client (AES-256-GCM)
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Blob chiffré (nonce|ciphertext|tag), max 100MB
 *     responses:
 *       200:
 *         description: Blob stocké
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 storage_key:
 *                   type: string
 */
router.post(
  '/upload',
  auth,
  uploadLimiter,
  uploadEncryptedBlob.single('file'),
  handleMulterError,
  uploadMedia
);

/**
 * @swagger
 * /api/media/{id}:
 *   get:
 *     summary: Télécharger un blob média chiffré
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Blob chiffré (application/octet-stream)
 *       404:
 *         description: Blob introuvable
 */
router.get('/:id', auth, getMedia);

module.exports = router;
