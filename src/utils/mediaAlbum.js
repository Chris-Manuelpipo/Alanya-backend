const ALBUM_MARKER_PREFIX = '__talky_album__';

/**
 * Décode le marqueur album stocké dans `content`.
 * Format : __talky_album__|{uuid}|{index}|{total}
 */
function parseAlbumMarker(content) {
  if (!content || !content.startsWith(ALBUM_MARKER_PREFIX)) return null;
  const parts = content.split('|');
  if (parts.length !== 4) return null;
  const index = parseInt(parts[2], 10);
  const total = parseInt(parts[3], 10);
  if (!parts[1] || Number.isNaN(index) || Number.isNaN(total) || total < 2) {
    return null;
  }
  return { albumId: parts[1], index, total };
}

/**
 * Libellé d'aperçu conversation pour un message album.
 * Sans info de type par item, on utilise `total` du marqueur.
 */
function albumPreviewFromMarker(marker) {
  const n = marker.total;
  if (n === 1) return '📷 Photo';
  return `📷 ${n} photos`;
}

/**
 * Aperçu lastMessage : masque le marqueur album, retombe sur le comportement habituel.
 */
function resolveLastMessagePreview({ content, mediaName, type }) {
  const marker = parseAlbumMarker(content);
  if (marker) return albumPreviewFromMarker(marker);
  if (content) return content.substring(0, 200);
  return mediaName ?? 'Média';
}

module.exports = {
  ALBUM_MARKER_PREFIX,
  parseAlbumMarker,
  albumPreviewFromMarker,
  resolveLastMessagePreview,
};
