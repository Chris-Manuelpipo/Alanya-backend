// src/routes/upload.js
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const auth    = require('../middleware/auth');

const router = express.Router();

// ─── DOSSIERS DE DESTINATION ──────────────────────────────────────────────────
// Chaque type de fichier va dans son propre sous-dossier.
// Ces dossiers sont créés automatiquement s'ils n'existent pas.
const UPLOAD_ROOT = path.join(__dirname, '../../uploads');

const FOLDERS = {
  image:    path.join(UPLOAD_ROOT, 'images'),
  audio:    path.join(UPLOAD_ROOT, 'audio'),
  video:    path.join(UPLOAD_ROOT, 'videos'),
  document: path.join(UPLOAD_ROOT, 'files'),
};

for (const folder of Object.values(FOLDERS)) {
  fs.mkdirSync(folder, { recursive: true });
}

// ─── CLASSIFICATION DES TYPES MIME ───────────────────────────────────────────

const MIME_TO_CATEGORY = {
  // Images
  'image/jpeg':    'image',
  'image/png':     'image',
  'image/gif':     'image',
  'image/webp':    'image',
  'image/svg+xml': 'image',
  // Audio
  'audio/mpeg':    'audio',
  'audio/mp4':     'audio',
  'audio/ogg':     'audio',
  'audio/webm':    'audio',
  'audio/wav':     'audio',
  'audio/opus':    'audio',
  // Vidéo
  'video/mp4':     'video',
  'video/webm':    'video',
  'video/ogg':     'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  // Documents
  'application/pdf':  'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'text/plain': 'document',
  'application/zip': 'document',
  'application/octet-stream': 'document',
};

// Type Flutter → catégorie (fallback si le MIME n'est pas reconnu)
function getCategory(mimetype) {
  return MIME_TO_CATEGORY[mimetype] ?? 'document';
}

// ─── STOCKAGE MULTER ──────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const category = getCategory(file.mimetype);
    cb(null, FOLDERS[category]);
  },
  filename: (req, file, cb) => {
    // Nom unique : timestamp + hash aléatoire + extension d'origine
    // Évite les collisions et les caractères dangereux dans le nom.
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const unique = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}_${unique}${ext}`);
  },
});

const LIMITS = {
  fileSize: 50 * 1024 * 1024, // 50 Mo max par fichier
};

// Filtre : rejette les types non reconnus (sécurité basique)
function fileFilter(req, file, cb) {
  if (MIME_TO_CATEGORY[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error(`Type de fichier non supporté : ${file.mimetype}`), false);
  }
}

const upload = multer({ storage, limits: LIMITS, fileFilter });

// ─── ROUTE POST /api/upload ───────────────────────────────────────────────────
//
// Champs attendus (multipart/form-data) :
//   file   — le fichier (obligatoire)
//
// Réponse :
//   { url, name, size, type, category }
//
router.post('/', auth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu' });
  }

  const file     = req.file;
  const category = getCategory(file.mimetype);

  // Construction de l'URL publique du fichier
  // Utilise le host de la requête pour être compatible dev et prod.
  const baseUrl  = `${req.protocol}://${req.get('host')}`;
  const subPath  = {
    image:    'images',
    audio:    'audio',
    video:    'videos',
    document: 'files',
  }[category];

  const publicUrl = `${baseUrl}/uploads/${subPath}/${file.filename}`;

  // Type numérique Flutter (0=text, 1=image, 2=video, 3=audio, 4=file)
  const typeMap = { image: 1, video: 2, audio: 3, document: 4 };

  res.json({
    url:      publicUrl,
    name:     file.originalname,
    size:     file.size,
    mimetype: file.mimetype,
    type:     typeMap[category] ?? 4,  // Pour que Flutter sache quel type afficher
    category,
  });
});

// ─── GESTION DES ERREURS MULTER ──────────────────────────────────────────────

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Fichier trop volumineux (max 50 Mo)' });
    }
    return res.status(400).json({ error: `Erreur upload : ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;