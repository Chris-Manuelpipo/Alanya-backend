/** Normalise une locale app (fr / en). */
function normalizeLocale(raw) {
  const s = String(raw || 'fr').toLowerCase();
  if (s.startsWith('en')) return 'en';
  return 'fr';
}

/**
 * Choisit la variante localisée.
 * - Welcome : field `content` → `content_fr` / `content_en`
 * - Broadcast : field `content` → `content` / `content_en`
 * - Statut : field `text` → `text` / `text_en`
 */
function pickLocalized(row, locale, field) {
  const frKey = `${field}_fr`;
  const enKey = `${field}_en`;
  const frVal = row[frKey] != null ? row[frKey] : row[field];
  if (locale === 'en') {
    const en = row[enKey];
    if (en != null && String(en).trim()) return String(en);
  }
  return frVal != null ? String(frVal) : '';
}

/** Corps push par défaut si le contenu est vide. */
function defaultBroadcastPushBody(kind, locale) {
  const isStatus = Number(kind) === 1;
  if (locale === 'en') {
    return isStatus ? 'New status' : 'New announcement';
  }
  return isStatus ? 'Nouveau statut' : 'Nouvelle annonce';
}

module.exports = {
  normalizeLocale,
  pickLocalized,
  defaultBroadcastPushBody,
};
