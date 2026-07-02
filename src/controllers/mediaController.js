const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const pool   = require('../config/db');
const { STORAGE_DIR } = require('../middleware/mediaUpload');

// Upload d'un blob média déjà chiffré (AES-256-GCM côté client). Le serveur
// reste zero-knowledge : il ne stocke que le blob opaque + des métadonnées
// techniques (hash, taille). Voir MEDIAS_E2EE.md.
const uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier reçu' });
    }

    const storageKey = req.file.filename;
    const byteSize   = req.file.size;

    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', resolve)
        .on('error', reject);
    });

    const [result] = await pool.execute(
      'INSERT INTO media_blobs (uploader_id, storage_key, sha256, byte_size) VALUES (?, ?, ?, ?)',
      [req.user.alanyaID, storageKey, hash.digest(), byteSize]
    );

    res.json({ id: result.insertId, storage_key: storageKey });
  } catch (error) {
    console.error('[Media upload] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Téléchargement d'un blob chiffré. Le serveur le sert tel quel
// (application/octet-stream) : mime/nom réels sont dans l'enveloppe E2EE.
const getMedia = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      'SELECT storage_key, byte_size FROM media_blobs WHERE id = ?',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Blob introuvable' });
    }

    const blobPath = path.join(STORAGE_DIR, rows[0].storage_key);
    if (!fs.existsSync(blobPath)) {
      return res.status(404).json({ error: 'Blob introuvable' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', rows[0].byte_size);
    fs.createReadStream(blobPath).pipe(res);
  } catch (error) {
    console.error('[Media download] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { uploadMedia, getMedia };
