const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const { uploadAvatar, uploadMedia: uploadMediaCtrl } = require('../controllers/uploadController');
const { uploadAvatar: multerAvatar, uploadMedia: multerMedia, handleMulterError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');

// POST /api/upload/avatar  — upload photo de profil
router.post(
  '/avatar',
  auth,
  uploadLimiter,
  multerAvatar.single('file'),
  handleMulterError,
  uploadAvatar
);

// POST /api/upload/media  — upload média pour message (image, audio, vidéo, fichier)
router.post(
  '/media',
  auth,
  uploadLimiter,
  multerMedia.single('file'),
  handleMulterError,
  uploadMediaCtrl
);

module.exports = router;