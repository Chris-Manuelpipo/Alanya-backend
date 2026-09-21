const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const {
  newMediaKey,
  newImageKey,
  safeExt,
} = require('../services/mediaStorage');

/** Plafonds d'envoi, partagés avec la route de ticket (envoi direct). */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
const MEDIA_MAX_BYTES  = 50 * 1024 * 1024;  // 50 MB

/**
 * Dossier de transit : multer y écrit, le contrôleur dépose le fichier chez
 * Backblaze puis le supprime. Rien ne s'attarde sur le disque du serveur.
 */
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'alanya-uploads');

// Créer les dossiers si nécessaire
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

/**
 * Supprime les fichiers de transit abandonnés — un processus arrêté en plein
 * envoi ne passe jamais par le `finally` qui les efface. Appelé au démarrage ;
 * ne touche qu'aux fichiers vieux de plus d'une heure.
 */
async function cleanStaleUploadTmp({
  dir = UPLOAD_TMP_DIR,
  maxAgeMs = 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  let noms;
  try {
    noms = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let supprimes = 0;
  for (const nom of noms) {
    const chemin = path.join(dir, nom);
    try {
      const st = await fs.promises.stat(chemin);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(chemin);
        supprimes += 1;
      }
    } catch {
      // Déjà supprimé par un autre processus : le but est atteint.
    }
  }
  return supprimes;
}

// Sauvegarde : images (avatars, photos groupe)
//
// La clé Backblaze est décidée ici et portée par `file` ; le fichier ne fait
// que transiter par `UPLOAD_TMP_DIR`.
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      file.storageKey = newImageKey({
        alanyaID: req.user.alanyaID,
        ext: safeExt(file.originalname),
      });
      ensureDir(UPLOAD_TMP_DIR);
      return cb(null, UPLOAD_TMP_DIR);
    } catch (e) {
      return cb(e);
    }
  },
  filename: (req, file, cb) => cb(null, path.basename(file.storageKey)),
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
// La clé — partition du jour comprise — est décidée ICI, à l'ouverture du
// flux, et le contrôleur la relit via `file.storageKey` au lieu de recalculer.
// Ce n'est pas de l'élégance : recomposer la date au moment de fabriquer
// l'URL ouvre une fenêtre à minuit. Un envoi commencé à 23:59:59 atterrit dans
// la partition du jour J, et une URL recomposée à 00:00:00 désignerait J+1,
// donc un objet qui n'existe pas. Une seule décision, relue, ferme la fenêtre.
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      file.storageKey = newMediaKey({
        kind: mediaSubDir(file.mimetype),
        alanyaID: req.user.alanyaID,
        ext: safeExt(file.originalname),
      });
      ensureDir(UPLOAD_TMP_DIR);
      return cb(null, UPLOAD_TMP_DIR);
    } catch (e) {
      return cb(e);
    }
  },
  filename: (req, file, cb) => cb(null, path.basename(file.storageKey)),
});

// Types acceptés — exportés pour la route de ticket, qui applique les mêmes
// règles avant d'autoriser un envoi direct.
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const MEDIA_MIME_TYPES = [
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

// Filtres de fichiers
const imageFilter = (req, file, cb) => {
  if (IMAGE_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Seuls les formats d\'image suivants sont autorisés (jpeg, png, webp, gif)'), false);
};

const mediaFilter = (req, file, cb) => {
  if (MEDIA_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
  cb(new Error(`Type de fichier ${file.mimetype} non autorisé`), false);
};

// Multer middleware
const uploadAvatar = multer({
  storage: imageStorage,
  limits:  { fileSize: AVATAR_MAX_BYTES },
  fileFilter: imageFilter,
});

const uploadMedia = multer({
  storage: mediaStorage,
  limits:  { fileSize: MEDIA_MAX_BYTES },
  fileFilter: mediaFilter,
});

// Middleware de gestion des erreurs Multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Fichier trop volumineux', code: 'FILE_TOO_LARGE' });
    }
    // Les messages de Multer sont en anglais et parlent de champs de formulaire
    // (« Unexpected field ») : ils n'apprennent rien à l'utilisateur.
    console.error('[Upload] MulterError:', err.code, err.message);
    return res.status(400).json({ error: 'Envoi refusé', code: 'UPLOAD_REJECTED' });
  }
  if (err) {
    // Seul `mediaFilter` / `avatarFilter` lève ici, et toujours pour un type de
    // fichier refusé : la prose reste, le code la rend traduisible.
    return res.status(400).json({ error: err.message, code: 'INVALID_EXTENSION' });
  }
  next();
};

module.exports = {
  uploadAvatar,
  uploadMedia,
  handleMulterError,
  mediaSubDir,
  IMAGE_MIME_TYPES,
  MEDIA_MIME_TYPES,
  AVATAR_MAX_BYTES,
  MEDIA_MAX_BYTES,
  UPLOAD_TMP_DIR,
  cleanStaleUploadTmp,
};
