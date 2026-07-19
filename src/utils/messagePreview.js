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

function locationPreviewFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  try {
    const data = JSON.parse(content);
    if (data == null || typeof data !== 'object') return null;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const address = typeof data.address === 'string' ? data.address.trim() : '';
    const label = name || address || 'Position';
    return `📍 ${label}`;
  } catch (_) {
    return null;
  }
}

function contactPreviewFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  try {
    const data = JSON.parse(content);
    if (data == null || typeof data !== 'object') return null;
    const id = Number(data.alanyaID);
    if (!Number.isFinite(id) || id <= 0) return null;
    const nom = typeof data.nom === 'string' ? data.nom.trim() : '';
    const pseudo = typeof data.pseudo === 'string' ? data.pseudo.trim() : '';
    const label = nom || pseudo || 'Contact';
    return `👤 ${label}`;
  } catch (_) {
    return null;
  }
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
    case 5:
      return '📍 Position';
    case 7:
      return '👤 Contact';
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
  const t = parseInt(type, 10) || 0;

  // type=5 : JSON lat/lng — ne jamais exposer le content brut.
  if (t === 5) {
    const loc = locationPreviewFromContent(content);
    return loc || mediaTypeLabel(5);
  }

  // type=7 : JSON contact — ne jamais exposer le content brut.
  if (t === 7) {
    const contact = contactPreviewFromContent(content);
    return contact || mediaTypeLabel(7);
  }

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
