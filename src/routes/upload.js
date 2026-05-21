const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const { uploadAvatar, uploadMedia: uploadMediaCtrl } = require('../controllers/uploadController');
const { uploadAvatar: multerAvatar, uploadMedia: multerMedia, handleMulterError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');

// Route pour l'upload d'avatar (image)
router.post(
  '/avatar',
  auth,
  uploadLimiter,
  multerAvatar.single('file'),
  handleMulterError,
  uploadAvatar
);

// Route pour l'upload de médias (images, vidéos)
router.post(
  '/media',
  auth,
  uploadLimiter,
  multerMedia.single('file'),
  handleMulterError,
  uploadMediaCtrl
);

module.exports = router;