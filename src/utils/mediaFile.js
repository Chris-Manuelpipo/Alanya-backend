const fs = require('fs');
const path = require('path');

/// Supprime physiquement un fichier média à partir de son URL publique
/// (`.../uploads/images/x.jpg` ou `.../uploads/media/<sous-dossier>/x`).
/// Best-effort : toute erreur est ignorée (fichier déjà absent, etc.).
const deleteMediaFile = (mediaUrl) => {
  try {
    if (!mediaUrl) return;
    const marker = '/uploads/';
    const idx = mediaUrl.indexOf(marker);
    if (idx === -1) return;
    const relative = mediaUrl.substring(idx + marker.length);
    const filePath = path.join(__dirname, '../../uploads', relative);
    fs.unlink(filePath, () => {});
  } catch (_) {
    /* ignore */
  }
};

module.exports = { deleteMediaFile };
