const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// Créer les dossiers si nécessaire
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// ── Storage : images (avatars, photos groupe) ─────────────────────────
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

// ── Storage : médias messages (images, fichiers, audio) ───────────────
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let subDir = 'files';
    if (file.mimetype.startsWith('image/'))  subDir = 'images';
    if (file.mimetype.startsWith('audio/'))  subDir = 'audio';
    if (file.mimetype.startsWith('video/'))  subDir = 'video';

    const dir = path.join(__dirname, `../../uploads/media/${subDir}`);
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `media_${req.user.alanyaID}_${Date.now()}${ext}`;
    cb(null, name);
  },
});

// ── Filtres ────────────────────────────────────────────────────────────
const imageFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Only images are allowed (jpeg, png, webp, gif)'), false);
};

const mediaFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/aac', 'audio/mp4',
    'video/mp4', 'video/webm',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'text/plain',
  ];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error(`File type ${file.mimetype} not allowed`), false);
};

// ── Instances multer ───────────────────────────────────────────────────
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

// ── Handler d'erreur Multer ────────────────────────────────────────────
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
};

module.exports = { uploadAvatar, uploadMedia, handleMulterError };