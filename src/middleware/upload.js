const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');

const { resolveUploadDirSync } = require('../services/mediaPartitions');
const {
  isB2Enabled,
  newMediaKey,
  newImageKey,
  newVoicemailGreetingKey,
  safeExt,
} = require('../services/mediaStorage');

/** Plafonds d'envoi, partagés avec la route de ticket (envoi direct). */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
const MEDIA_MAX_BYTES  = 50 * 1024 * 1024;  // 50 MB
const GREETING_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — dix secondes de voix

/**
 * Dossier de transit quand les médias vont chez Backblaze : multer y écrit,
 * le contrôleur dépose le fichier chez Backblaze puis le supprime. Hors de
 * `uploads/`, qui est servi en statique.
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
// Stockage objet : la clé Backblaze est décidée ici et portée par `file` ;
// le fichier ne fait que transiter par `UPLOAD_TMP_DIR`.
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (isB2Enabled()) {
        file.storageKey = newImageKey({
          alanyaID: req.user.alanyaID,
          ext: safeExt(file.originalname),
        });
        ensureDir(UPLOAD_TMP_DIR);
        return cb(null, UPLOAD_TMP_DIR);
      }
      const dir = path.join(__dirname, '../../uploads/images');
      ensureDir(dir);
      return cb(null, dir);
    } catch (e) {
      return cb(e);
    }
  },
  filename: (req, file, cb) => {
    if (file.storageKey) return cb(null, path.basename(file.storageKey));
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `img_${req.user.alanyaID}_${Date.now()}${ext}`;
    return cb(null, name);
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
//
// Stockage objet : même règle, la clé Backblaze (partition comprise) est
// décidée ici et relue par le contrôleur via `file.storageKey`.
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (isB2Enabled()) {
        file.storageKey = newMediaKey({
          kind: mediaSubDir(file.mimetype),
          alanyaID: req.user.alanyaID,
          ext: safeExt(file.originalname),
        });
        ensureDir(UPLOAD_TMP_DIR);
        return cb(null, UPLOAD_TMP_DIR);
      }
      const { absolu } = resolveUploadDirSync(mediaSubDir(file.mimetype));
      return cb(null, absolu);
    } catch (e) {
      return cb(e);
    }
  },
  filename: (req, file, cb) => {
    if (file.storageKey) return cb(null, path.basename(file.storageKey));
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `media_${req.user.alanyaID}_${Date.now()}${ext}`;
    return cb(null, name);
  },
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
/**
 * Sauvegarde : annonces de répondeur.
 *
 * Répertoire à part, et c'est la raison d'être de ce troisième stockage.
 * `uploads/media/` est balayé par `sweepPartitions`, qui SUPPRIME le répertoire
 * daté entier sans consulter aucune table : une annonce rangée là disparaîtrait
 * d'elle-même au bout de la rétention, sans qu'aucune ligne `message` ne soit
 * en cause. `uploads/voicemail/`, comme `uploads/images/`, n'est balayé par
 * rien.
 */
const greetingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (isB2Enabled()) {
        file.storageKey = newVoicemailGreetingKey({
          alanyaID: req.user.alanyaID,
          ext: safeExt(file.originalname),
        });
        ensureDir(UPLOAD_TMP_DIR);
        return cb(null, UPLOAD_TMP_DIR);
      }
      const dir = path.join(__dirname, '../../uploads/voicemail');
      ensureDir(dir);
      return cb(null, dir);
    } catch (e) {
      return cb(e);
    }
  },
  filename: (req, file, cb) => {
    if (file.storageKey) return cb(null, path.basename(file.storageKey));
    // Le hasard fait ici office d'empreinte : le cache client indexe par nom de
    // fichier, donc réenregistrer DOIT produire un autre nom.
    const ext = safeExt(file.originalname) || '.m4a';
    return cb(null, `vm_${req.user.alanyaID}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

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

/**
 * Annonce de répondeur : dix secondes de voix, deux mégaoctets de plafond.
 *
 * Le plafond est volontairement écrasant pour la durée visée — dix secondes en
 * mono à débit réduit pèsent une quarantaine de kilooctets. Il n'est là que
 * pour refuser un envoi manifestement absurde, pas pour arbitrer la qualité.
 */
const uploadVoicemailGreeting = multer({
  storage: greetingStorage,
  limits:  { fileSize: GREETING_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (String(file.mimetype || '').startsWith('audio/')
      || file.mimetype === 'video/mp4' /* certains .m4a se déclarent ainsi */) {
      return cb(null, true);
    }
    cb(new Error('L\'annonce doit être un fichier audio'), false);
  },
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
  uploadVoicemailGreeting,
  handleMulterError,
  mediaSubDir,
  IMAGE_MIME_TYPES,
  MEDIA_MIME_TYPES,
  AVATAR_MAX_BYTES,
  MEDIA_MAX_BYTES,
  GREETING_MAX_BYTES,
  UPLOAD_TMP_DIR,
  cleanStaleUploadTmp,
};
