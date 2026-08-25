/**
 * Locales du contenu officiel (diffusions, statuts officiels, bienvenue).
 *
 * `fr` et `en` sont les langues de référence : l'éditeur d'administration les
 * exige. Les autres sont facultatives — sans elles, la chaîne de repli ci-
 * dessous prend le relais. Exiger toutes les langues bloquerait la publication
 * jusqu'à ce qu'un traducteur soit disponible, ce qui n'est pas tenable.
 *
 * Ajouter une langue ici (et le fichier ARB correspondant côté client) suffit
 * désormais : plus de colonne `_xx` à poser sur trois tables.
 */
const SUPPORTED_CONTENT_LOCALES = ['fr', 'en', 'zh'];

/** Langues dont l'éditeur d'administration exige la saisie. */
const REQUIRED_CONTENT_LOCALES = ['fr', 'en'];

/**
 * Ordre de repli quand la traduction demandée manque.
 *
 * Un utilisateur chinois sans version chinoise voit l'anglais, pas le
 * français : on descend vers la langue la plus largement comprise avant de
 * retomber sur la langue d'origine du contenu.
 */
const FALLBACK_CHAIN = ['en', 'fr'];

/**
 * Normalise une locale applicative.
 *
 * ⚠️ Cette fonction était un entonnoir : tout ce qui ne commençait pas par
 * `en` retombait sur `fr`. Un utilisateur `zh` recevait donc les annonces
 * officielles en français. Elle valide désormais contre la liste supportée et
 * ne retombe sur `fr` que pour une valeur réellement inconnue.
 */
function normalizeLocale(raw) {
  const s = String(raw || 'fr').toLowerCase();
  const primary = s.split(/[-_]/)[0];
  return SUPPORTED_CONTENT_LOCALES.includes(primary) ? primary : 'fr';
}

/**
 * Résout un champ localisé depuis des lignes `*_i18n`.
 *
 * [rows] est un tableau d'objets portant au moins `locale` et la valeur, sous
 * la clé [valueKey] (`content`, `text`, `value` selon la table).
 *
 * Parcourt : locale demandée → chaîne de repli → première valeur non vide.
 * Le dernier maillon compte : un contenu saisi uniquement dans une langue non
 * conventionnelle vaut mieux qu'une chaîne vide à l'écran.
 */
function resolveI18n(rows, locale, { valueKey = 'content', field = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const scoped = field === null
    ? rows
    : rows.filter((r) => r.field === field);
  if (scoped.length === 0) return null;

  const valueFor = (loc) => {
    const hit = scoped.find((r) => normalizeLocale(r.locale) === loc);
    if (!hit) return null;
    const raw = hit[valueKey];
    return raw != null && String(raw).trim() ? String(raw) : null;
  };

  const wanted = normalizeLocale(locale);
  const ordered = [wanted, ...FALLBACK_CHAIN.filter((l) => l !== wanted)];
  for (const loc of ordered) {
    const v = valueFor(loc);
    if (v != null) return v;
  }

  for (const r of scoped) {
    const raw = r[valueKey];
    if (raw != null && String(raw).trim()) return String(raw);
  }
  return null;
}

/**
 * Résolution héritée, sur les colonnes `_fr` / `_en` de la ligne elle-même.
 *
 * Conservée le temps de la double écriture : les services lisent d'abord les
 * tables `*_i18n` et retombent ici quand elles ne portent encore rien pour
 * l'objet demandé (contenus créés avant la migration 053 et non repris). À
 * supprimer en même temps que les colonnes.
 *
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
  if (normalizeLocale(locale) !== 'fr') {
    const en = first(`${field}_en`, `${field}En`);
    if (en != null && String(en).trim()) return String(en);
  }
  return frVal != null ? String(frVal) : '';
}

/**
 * Langues requises manquantes sur un contenu **qui porte du texte**.
 *
 * Un contenu vide dans toutes les langues ne réclame rien : une légende absente
 * est légitime sur un bloc image ou vidéo, et une publication ne doit pas s'en
 * trouver bloquée. Dès qu'une langue est saisie — fût-elle facultative — toutes
 * les langues requises le deviennent.
 *
 * Miroir de `untranslatedRequiredLocales`
 * (alanya-admin/lib/content-locales.ts) : l'éditeur refuse avant le serveur,
 * mais avec la même règle, sinon l'administrateur découvre le refus à l'envoi.
 *
 * @param {Record<string, string|null|undefined>|null|undefined} translations
 * @returns {string[]} les locales requises à compléter, vide si rien n'est dû.
 */
function untranslatedRequiredLocales(translations) {
  const filled = (locale) => String(translations?.[locale] ?? '').trim() !== '';
  if (!SUPPORTED_CONTENT_LOCALES.some(filled)) return [];
  return REQUIRED_CONTENT_LOCALES.filter((locale) => !filled(locale));
}

/** Corps push par défaut si le contenu est vide. */
function defaultBroadcastPushBody(kind, locale) {
  const isStatus = Number(kind) === 1;
  switch (normalizeLocale(locale)) {
    case 'en':
      return isStatus ? 'New status' : 'New announcement';
    case 'zh':
      return isStatus ? '新动态' : '新公告';
    default:
      return isStatus ? 'Nouveau statut' : 'Nouvelle annonce';
  }
}

module.exports = {
  SUPPORTED_CONTENT_LOCALES,
  REQUIRED_CONTENT_LOCALES,
  normalizeLocale,
  resolveI18n,
  pickLocalized,
  untranslatedRequiredLocales,
  defaultBroadcastPushBody,
};
