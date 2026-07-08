const ALBUM_PREFIX = '__talky_album__';

/**
 * Décode un marqueur album et renvoie le libellé d'aperçu
 * (ex. « 📷 5 photos, 🎥 Vidéo »), ou null si ce n'est pas un album.
 */
function albumPreviewFromContent(content) {
  if (!content || typeof content !== 'string' || !content.startsWith(ALBUM_PREFIX)) {
    return null;
  }
  const header = content.split('\n')[0];
  const parts = header.split('|');
  if (parts.length !== 4 && parts.length !== 6) return null;

  const total = parseInt(parts[3], 10);
  if (!parts[1] || Number.isNaN(total) || total < 2) return null;

  if (parts.length === 6) {
    const photos = parseInt(parts[4], 10);
    const videos = parseInt(parts[5], 10);
    if (Number.isNaN(photos) || Number.isNaN(videos)) return null;

    const labels = [];
    if (photos > 0) {
      labels.push(photos === 1 ? '📷 Photo' : `📷 ${photos} photos`);
    }
    if (videos > 0) {
      labels.push(videos === 1 ? '🎥 Vidéo' : `🎥 ${videos} vidéos`);
    }
    return labels.length ? labels.join(', ') : '📷 Album';
  }

  return total === 1 ? '📷 Photo' : `📷 ${total} photos`;
}

function mediaTypeLabel(type, { isViewOnce = false, mediaName } = {}) {
  const t = parseInt(type, 10) || 0;
  switch (t) {
    case 1:
      return isViewOnce ? '📷 Photo · Vue unique' : '📷 Photo';
    case 2:
      return isViewOnce ? '🎥 Vidéo · Vue unique' : '🎥 Vidéo';
    case 3:
      return isViewOnce ? '🎵 Audio · Vue unique' : '🎵 Audio';
    case 4:
      return mediaName ? `📎 ${mediaName}` : '📎 Fichier';
    default:
      return mediaName ?? 'Média';
  }
}

/**
 * Aperçu stocké dans conversation.lastMessage / notifications.
 * Ne jamais exposer le marqueur brut `__talky_album__|…`.
 * Aligné sur Talky `_previewForMedia`.
 */
function messagePreview({
  content,
  mediaName,
  type = 0,
  isViewOnce = false,
  isEncrypted = false,
  maxLen = 200,
}) {
  if (isEncrypted) return '🔒 Message chiffré';

  const viewOnce = isViewOnce === true || isViewOnce === 1 || isViewOnce === '1';

  if (!viewOnce) {
    const album = albumPreviewFromContent(content);
    if (album) return album;

    if (content && String(content).trim()) {
      const text = String(content);
      return text.length > maxLen ? text.substring(0, maxLen) : text;
    }
  }

  return mediaTypeLabel(type, { isViewOnce: viewOnce, mediaName });
}

module.exports = { albumPreviewFromContent, mediaTypeLabel, messagePreview };
