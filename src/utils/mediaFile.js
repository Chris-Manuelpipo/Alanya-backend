const { storedKeyFromUrl, removeAllVersions } = require('../services/mediaStorage');

/// Supprime chez Backblaze le média désigné par son URL publique
/// (`.../uploads/images/x.jpg` ou `.../uploads/media/<partition>/<kind>/x`).
/// Best-effort : toute erreur est journalisée, jamais propagée.
///
/// **Toutes versions comprises.** Une suppression simple ne ferait que masquer
/// l'objet jusqu'au passage quotidien des règles de cycle de vie, ce qui ne
/// convient pas à un média à vue unique consommé.
const deleteMediaFile = (mediaUrl) => {
  const key = storedKeyFromUrl(mediaUrl);
  if (!key) return;
  removeAllVersions(key).catch((e) => {
    console.error('[MediaFile] suppression Backblaze échouée:', e.message);
  });
};

module.exports = { deleteMediaFile };
