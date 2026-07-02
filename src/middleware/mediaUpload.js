const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// Stockage des blobs médias déjà chiffrés côté client (AES-256-GCM). Voir
// MEDIAS_E2EE.md : le serveur ne voit qu'un blob opaque, jamais le fichier
// en clair ni sa clé.
const STORAGE_DIR = path.join(__dirname, '../../uploads/media_blobs');

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const blobStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(STORAGE_DIR);
    cb(null, STORAGE_DIR);
  },
  filename: (req, file, cb) => {
    // Nom aléatoire : le vrai nom/mime du fichier ne doivent jamais
    // apparaître côté serveur (ils voyagent chiffrés dans l'enveloppe E2EE).
    cb(null, crypto.randomBytes(24).toString('hex'));
  },
});

// Pas de fileFilter : le contenu est un blob chiffré opaque, son "type"
// MIME réel n'est ni connu ni pertinent côté serveur.
const uploadEncryptedBlob = multer({
  storage: blobStorage,
  limits:  { fileSize: 100 * 1024 * 1024 }, // 100 MB (streaming par chunks : voir §4.4 de MEDIAS_E2EE.md)
});

module.exports = { uploadEncryptedBlob, STORAGE_DIR };
