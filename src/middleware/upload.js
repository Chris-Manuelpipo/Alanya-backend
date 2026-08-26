const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { resolveUploadDirSync } = require('../services/mediaPartitions');

// Créer les dossiers si nécessaire
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// Sauvegarde : images (avatars, photos groupe)
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/images');
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `img_${req.user.alanyaID}_${Date.now()}${ext}`;
    cb(null, name);
  },
});

/**
 * Sous-dossier d'un média d'après son type MIME.
 * Exporté pour que le contrôleur n'en tienne pas une seconde copie.
 */
const mediaSubDir = (mimetype = '') => {
  if (mimetype.startsWith('image/')) return 'images';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  return 'files';
};

// Sauvegarde : médias messages (images, fichiers, audio)
//
// Le répertoire est décidé par `resolveUploadDirSync` : disposition
// historique tant que l'interrupteur des partitions est éteint, tranche du
// jour ensuite (`uploads/media/<AAAA-MM-JJ>/<sous-dossier>`).
//
// Le choix est fait ICI, à l'ouverture du flux, et le contrôleur relit ensuite
// `req.file.destination` au lieu de recalculer. Ce n'est pas de l'élégance :
// avec des partitions, recalculer la date au moment de composer l'URL ouvre
// une fenêtre à minuit — un upload commencé à 23:59:59 atterrit dans la
// partition du jour J, et une URL recomposée à 00:00:00 désignerait J+1, donc
// un fichier qui n'y est pas. Une seule décision, relue, ferme la fenêtre.
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const { absolu } = resolveUploadDirSync(mediaSubDir(file.mimetype));
      cb(null, absolu);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `media_${req.user.alanyaID}_${Date.now()}${ext}`;
    cb(null, name);
  },
});

// Filtres de fichiers
const imageFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Seuls les formats d\'image suivants sont autorisés (jpeg, png, webp, gif)'), false);
};

const mediaFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    // Audio — inclure les variantes `x-` : le package `mime` côté Flutter
    // renvoie audio/x-wav pour .wav, audio/x-flac pour .flac, etc.
    'audio/mpeg', 'audio/mp3', 'audio/x-mpeg',
    'audio/ogg', 'audio/vorbis', 'audio/opus',
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave',
    'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm',
    'audio/flac', 'audio/x-flac',
    'audio/x-ms-wma',
    'audio/aiff', 'audio/x-aiff',
    'audio/midi', 'audio/x-midi',
    'audio/x-caf', 'audio/amr',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/csv',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/rtf',
    'text/rtf',
    'application/zip',
    'application/x-7z-compressed',
    'application/vnd.rar',
    'application/x-rar-compressed',
    'application/vnd.android.package-archive',
    'text/plain',
  ];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error(`Type de fichier ${file.mimetype} non autorisé`), false);
};

// Multer middleware
const uploadAvatar = multer({
  storage: imageStorage,
  limits:  { fileSize: 5 * 1024 * 1024 },  // 5 MB
  fileFilter: imageFilter,
});

const uploadMedia = multer({
  storage: mediaStorage,
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: mediaFilter,
});

// Middleware de gestion des erreurs Multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Fichier trop volumineux' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
};

module.exports = { uploadAvatar, uploadMedia, handleMulterError, mediaSubDir };