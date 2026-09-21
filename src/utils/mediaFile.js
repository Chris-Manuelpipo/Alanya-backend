const fs = require('fs');
const path = require('path');

const { isB2Enabled, storedKeyFromUrl, removeAllVersions } = require('../services/mediaStorage');

/// Supprime physiquement un fichier média à partir de son URL publique
/// (`.../uploads/images/x.jpg` ou `.../uploads/media/<sous-dossier>/x`).
/// Best-effort : toute erreur est ignorée (fichier déjà absent, etc.).
///
/// Stockage objet : le fichier est aussi supprimé chez Backblaze, **toutes
/// versions comprises**. Une suppression simple ne ferait que le masquer
/// jusqu'au passage quotidien des règles de cycle de vie, ce qui ne convient
/// pas à un média à vue unique consommé.
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
  if (isB2Enabled()) {
    const key = storedKeyFromUrl(mediaUrl);
    if (key) {
      removeAllVersions(key).catch((e) => {
        console.error('[MediaFile] suppression Backblaze échouée:', e.message);
      });
    }
  }
};

module.exports = { deleteMediaFile };
