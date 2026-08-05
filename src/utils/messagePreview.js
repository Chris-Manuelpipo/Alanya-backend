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

/**
 * Aperçu d'un message système de groupe (`type = 6`).
 *
 * Le `content` est un payload JSON machine-lisible : ne JAMAIS l'exposer brut
 * dans `conversation.lastMessage`.
 *
 * Le libellé produit ici est en français en dur, et c'est assumé : le serveur
 * n'a pas de contexte de locale, et cette valeur n'est qu'une **amorce** pour
 * la liste de conversations. Le client re-dérive un aperçu localisé dès qu'il
 * possède le message (ConversationSummaryReducer + SystemEventPayload.label).
 * Même compromis que la sentinelle `ConversationMerge.deletedPreview`.
 *
 * Les libellés restent volontairement courts et sans les noms des cibles : une
 * ligne d'aperçu est tronquée, et le fil porte déjà la phrase complète.
 */
function systemPreviewFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  let data;
  try {
    data = JSON.parse(content);
  } catch (_) {
    return null;
  }
  if (data == null || typeof data !== 'object') return null;

  const actor = typeof data.byName === 'string' ? data.byName.trim() : '';
  const value = typeof data.value === 'string' ? data.value.trim() : '';
  const who = actor !== '' ? actor : 'Quelqu\'un';

  switch (data.e) {
    case 'group_created':
      return value !== '' ? `${who} a créé « ${value} »` : `${who} a créé le groupe`;
    case 'member_added':
      return `${who} a ajouté des membres`;
    case 'member_removed':
      return `${who} a retiré un membre`;
    case 'member_left':
      return `${who} a quitté le groupe`;
    case 'group_renamed':
      return value !== ''
        ? `${who} a renommé le groupe en « ${value} »`
        : `${who} a renommé le groupe`;
    case 'group_photo_changed':
      return `${who} a changé la photo du groupe`;
    case 'group_description_changed':
      return `${who} a modifié la description`;
    case 'role_changed':
      return Number(data.role) >= 1
        ? `${who} a nommé un administrateur`
        : `${who} a retiré des droits d'administrateur`;
    case 'settings_changed':
      return `${who} a modifié les réglages du groupe`;
    default:
      // Événement inconnu : un libellé neutre vaut mieux que du JSON brut.
      return 'Le groupe a été mis à jour';
  }
}

// Extensions traitées comme de la musique. Miroir de la liste de
// lib/core/utils/audio_message_kind.dart côté Talky — garder les deux alignées.
const MUSIC_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus',
  'wma', 'aiff', 'aif', 'caf', 'amr', 'weba', 'mid', 'midi', 'alac',
]);

/**
 * Vocal ou musique : les deux sont des messages `type = 3`, seul le nom de
 * fichier les distingue. Un vocal enregistré porte un libellé localisé
 * (« Message vocal »), sans extension.
 */
function musicTitle(mediaName) {
  if (typeof mediaName !== 'string') return null;
  const base = mediaName.trim().split('/').pop().split('?')[0];
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot >= base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!MUSIC_EXTENSIONS.has(ext)) return null;
  const title = base.slice(0, dot).trim();
  return title || null;
}

function mediaTypeLabel(type, { isViewOnce = false, mediaName } = {}) {
  const t = parseInt(type, 10) || 0;
  switch (t) {
    case 1:
      return isViewOnce ? '📷 Photo · Vue unique' : '📷 Photo';
    case 2:
      return isViewOnce ? '🎥 Vidéo · Vue unique' : '🎥 Vidéo';
    case 3: {
      if (isViewOnce) return '🎵 Audio · Vue unique';
      const track = musicTitle(mediaName);
      return track ? `🎵 ${track}` : '🎤 Message vocal';
    }
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

  // type=8 : boutons CTA (message de bienvenue officiel).
  if (t === 8) {
    try {
      const parsed = JSON.parse(String(content || '{}'));
      const buttons = Array.isArray(parsed.buttons) ? parsed.buttons : [];
      if (buttons.length) return buttons.map((b) => b.label).filter(Boolean).join(' · ');
    } catch (_) { /* ignore */ }
    return 'Message de bienvenue';
  }

  // type=6 : événement de groupe, JSON lui aussi. Le court-circuit doit rester
  // AVANT le traitement générique, qui renverrait le payload brut.
  if (t === 6) {
    return systemPreviewFromContent(content) || 'Le groupe a été mis à jour';
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

module.exports = {
  albumPreviewFromContent,
  mediaTypeLabel,
  messagePreview,
  systemPreviewFromContent,
};
