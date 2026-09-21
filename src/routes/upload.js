const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const {
  uploadAvatar,
  uploadMedia: uploadMediaCtrl,
  uploadTicket: uploadTicketCtrl,
} = require('../controllers/uploadController');
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

/**
 * @swagger
 * /api/upload/ticket:
 *   post:
 *     summary: Autoriser un envoi direct vers le stockage objet
 *     description: >
 *       Contrôle le type et la taille annoncés (mêmes règles que /upload/media
 *       et /upload/avatar), fixe la clé, puis renvoie un lien d'envoi signé (PUT)
 *       vers Backblaze B2. Le fichier part ensuite directement du client. Tant
 *       que le stockage objet n'est pas actif, la réponse est
 *       `{ mode: "multipart" }` et le client envoie par formulaire comme avant.
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mimetype, size]
 *             properties:
 *               kind:
 *                 type: string
 *                 enum: [media, avatar]
 *                 default: media
 *               mimetype:
 *                 type: string
 *               size:
 *                 type: integer
 *                 description: Taille exacte du fichier, en octets
 *               fileName:
 *                 type: string
 *                 description: Nom d'origine, pour l'extension
 *     responses:
 *       200:
 *         description: >
 *           `mode: "direct"` avec uploadUrl, headers (à renvoyer à l'identique),
 *           expiresIn, url, filename, mimetype, size, msgType — ou
 *           `mode: "multipart"`.
 *       400:
 *         description: Type refusé (INVALID_EXTENSION) ou requête invalide (VALIDATION_FAILED)
 *       413:
 *         description: Fichier trop volumineux (FILE_TOO_LARGE)
 *       503:
 *         description: Stockage des médias indisponible (STORAGE_UNAVAILABLE)
 */
router.post('/ticket', auth, uploadLimiter, uploadTicketCtrl);

module.exports = router;
