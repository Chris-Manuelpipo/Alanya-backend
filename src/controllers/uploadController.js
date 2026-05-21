const path = require('path');
const pool = require('../config/db');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Upload avatar (profil ou groupe) 
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filename = req.file.filename;
    const url      = `${BASE_URL}/uploads/images/${filename}`;

    // Mettre à jour l'avatar en base
    await pool.execute(
      'UPDATE users SET avatar_url = ? WHERE alanyaID = ?',
      [url, req.user.alanyaID]
    );

    res.json({ url, filename });
  } catch (error) {
    console.error('[Upload avatar] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Upload média message (image, audio, vidéo, fichier) 
const uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file     = req.file;
    const filename = file.filename;
    const mimetype = file.mimetype;

    let subDir = 'files';
    if (mimetype.startsWith('image/')) subDir = 'images';
    if (mimetype.startsWith('audio/')) subDir = 'audio';
    if (mimetype.startsWith('video/')) subDir = 'video';

    const url      = `${BASE_URL}/uploads/media/${subDir}/${filename}`;
    const name     = file.originalname;
    const size     = file.size;

    // Détecter le type message selon mimetype
    // 0=texte, 1=image, 2=vidéo, 3=audio, 4=fichier
    let msgType = 4;
    if (mimetype.startsWith('image/')) msgType = 1;
    if (mimetype.startsWith('video/')) msgType = 2;
    if (mimetype.startsWith('audio/')) msgType = 3;

    res.json({
      url,
      filename,
      originalName: name,
      mimetype,
      size,
      msgType,
    });
  } catch (error) {
    console.error('[Upload media] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { uploadAvatar, uploadMedia };