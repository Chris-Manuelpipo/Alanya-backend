const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const { uploadAvatar, uploadMedia: uploadMediaCtrl } = require('../controllers/uploadController');
const { uploadAvatar: multerAvatar, uploadMedia: multerMedia, handleMulterError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');

/**
 * @swagger
 * /api/upload/avatar:
 *   post:
 *     summary: Héberger une image (avatar, photo de groupe, etc.)
 *     description: >
 *       Stocke le fichier et retourne son URL. Ne met pas à jour automatiquement
 *       le profil utilisateur - utiliser PUT /auth/me avec avatar_url pour un avatar
 *       personnel, ou POST /conversations/group avec groupPhoto pour un groupe.
 *     tags: [Upload]
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
 *                 description: Image (max 5MB)
 *     responses:
 *       200:
 *         description: Image hébergée (url + filename)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 filename:
 *                   type: string
 */
router.post(
  '/avatar',
  auth,
  uploadLimiter,
  multerAvatar.single('file'),
  handleMulterError,
  uploadAvatar
);

/**
 * @swagger
 * /api/upload/media:
 *   post:
 *     summary: Uploader un média (image, audio, vidéo, fichier)
 *     tags: [Upload]
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
 *                 description: Fichier média (max 50MB)
 *     responses:
 *       200:
 *         description: Média uploadé
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 filename:
 *                   type: string
 *                 originalName:
 *                   type: string
 *                 mimetype:
 *                   type: string
 *                 size:
 *                   type: integer
 *                 msgType:
 *                   type: integer
 */
router.post(
  '/media',
  auth,
  uploadLimiter,
  multerMedia.single('file'),
  handleMulterError,
  uploadMediaCtrl
);

module.exports = router;
