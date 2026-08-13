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
 *
 * Les deux conventions de nommage sont acceptées. Les diffusions passent une
 * ligne SQL brute (`content_en`), tandis que les blocs de bienvenue arrivent
 * déjà convertis par `mapBlockRow` (`contentEn`) : ne reconnaître que la
 * première renvoyait silencieusement une chaîne vide pour tout le message de
 * bienvenue.
 */
function pickLocalized(row, locale, field) {
  const first = (...keys) => {
    for (const k of keys) if (row[k] != null) return row[k];
    return null;
  };
  const frVal = first(`${field}_fr`, `${field}Fr`, field);
  if (locale === 'en') {
    const en = first(`${field}_en`, `${field}En`);
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
