const { messagePreview } = require('./messagePreview');

const ALBUM_MARKER_PREFIX = '__talky_album__';

/**
 * Décode le marqueur album stocké dans `content`.
 * Format : __talky_album__|{uuid}|{index}|{total}[|photos|videos]
 */
function parseAlbumMarker(content) {
  if (!content || !content.startsWith(ALBUM_MARKER_PREFIX)) return null;
  const header = content.split('\n')[0];
  const parts = header.split('|');
  if (parts.length !== 4 && parts.length !== 6) return null;
  const index = parseInt(parts[2], 10);
  const total = parseInt(parts[3], 10);
  if (!parts[1] || Number.isNaN(index) || Number.isNaN(total) || total < 2) {
    return null;
  }
  const marker = { albumId: parts[1], index, total };
  if (parts.length === 6) {
    marker.photoCount = parseInt(parts[4], 10);
    marker.videoCount = parseInt(parts[5], 10);
  }
  return marker;
}

/**
 * Libellé d'aperçu conversation pour un message album (legacy).
 */
function albumPreviewFromMarker(marker) {
  const n = marker.total;
  if (n === 1) return '📷 Photo';
  return `📷 ${n} photos`;
}

/**
 * Aperçu lastMessage : délègue à messagePreview pour une logique unique.
 */
function resolveLastMessagePreview({ content, mediaName, type, isViewOnce }) {
  return messagePreview({ content, mediaName, type, isViewOnce, maxLen: 200 });
}

module.exports = {
  ALBUM_MARKER_PREFIX,
  parseAlbumMarker,
  albumPreviewFromMarker,
  resolveLastMessagePreview,
};
