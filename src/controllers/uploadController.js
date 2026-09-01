const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const pool = require('../config/db');
const { UPLOADS_DIR } = require('../services/mediaPartitions');
const { invalidateSenderIdentity } = require('../utils/senderIdentityCache');

const _toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * Chemin public d'un fichier déposé par multer, relatif à `/uploads/`.
 *
 * Se déduit du répertoire de destination réel plutôt que du type MIME : c'est
 * la seule façon d'obtenir la même valeur que celle qui a servi à écrire le
 * fichier, quelle que soit la disposition (historique ou partitionnée).
 * Les séparateurs sont normalisés en barres obliques — un chemin de fichier
 * n'est pas une URL.
 */
const publicPathFor = (file) => {
  const relatif = path.relative(UPLOADS_DIR, file.destination);
  return `${relatif.split(path.sep).join('/')}/${file.filename}`;
};

// Héberge une image (avatar profil, photo de groupe, etc.) et retourne son URL.
// Par défaut ne modifie aucune entité en base ; avec applyToProfile=true, met
// à jour avatar_url de l'utilisateur connecté en une seule requête.
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filename = req.file.filename;
    const url      = `${BASE_URL}/uploads/images/${filename}`;
    const applyToProfile = _toBool(req.body?.applyToProfile ?? req.query?.applyToProfile);

    if (applyToProfile) {
      if (!req.user?.alanyaID) {
        return res.status(401).json({ error: 'Authentification requise pour applyToProfile' });
      }
      await pool.execute(
        'UPDATE users SET avatar_url = ? WHERE alanyaID = ?',
        [url, req.user.alanyaID],
      );
      // Le payload temps réel des messages sert l'avatar depuis un cache 60 s.
      invalidateSenderIdentity(req.user.alanyaID);
    }

    res.json({
      url,
      filename,
      ...(applyToProfile ? { appliedToProfile: true } : {}),
    });
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

    // L'URL est composée à partir du répertoire RÉELLEMENT choisi par multer
    // (`file.destination`), jamais recalculée. Avec le stockage partitionné,
    // recomposer la date ici rouvrirait une fenêtre à minuit : un upload
    // commencé à 23:59:59 est écrit dans la partition du jour J, et une URL
    // recalculée à 00:00:00 désignerait J+1 — un fichier qui n'existe pas.
    // Cette lecture rend aussi la bascule d'interrupteur transparente : le
    // contrôleur n'a pas à savoir si la disposition est partitionnée ou non.
    const url      = `${BASE_URL}/uploads/${publicPathFor(file)}`;
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
