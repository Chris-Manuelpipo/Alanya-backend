/**
 * Textes localisés des stickers : `name_i18n` / `description_i18n`, objets
 * `{"fr":…,"en":…,"zh":…}` (contrat §3).
 *
 * Repli : langue demandée → `en` → `fr`. Une clé absente, vide ou faite
 * d'espaces compte pour absente. Le serveur renvoie au client une chaîne DÉJÀ
 * résolue ; l'administration lit et écrit l'objet complet.
 *
 * Autre chaîne que `utils/localeContent` (diffusions, bienvenue) : celle-ci
 * travaille sur des lignes par locale et retombe sur « la première valeur
 * non vide » ; ici le contrat fixe l'ordre et rien d'autre.
 */

const SUPPORTED = ['fr', 'en', 'zh'];
const REPLI = ['en', 'fr'];

/** `fr-CA`, `zh_CN`, `EN` → `fr`, `zh`, `en`. Une langue hors liste reste telle quelle. */
function langueDe(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s.split(/[-_]/)[0] || '';
}

/** Première langue de `Accept-Language` (`zh-CN,zh;q=0.9,en;q=0.8` → `zh`). */
function langueDeEntete(entete) {
  if (typeof entete !== 'string') return '';
  const premiere = entete.split(',')[0].split(';')[0];
  return langueDe(premiere);
}

/** Un objet i18n lu en base : objet déjà décodé par mysql2, ou chaîne JSON. */
function lireObjet(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return Array.isArray(raw) ? {} : raw;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}

const present = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * @param {object|string|null} i18n
 * @param {string} lang   langue demandée (déjà normalisée ou non)
 * @returns {string}  chaîne résolue, ou '' si aucune langue n'a de texte
 */
function resoudre(i18n, lang) {
  const o = lireObjet(i18n);
  const demandee = langueDe(lang);
  for (const l of [demandee, ...REPLI]) {
    if (!l) continue;
    const v = present(Object.prototype.hasOwnProperty.call(o, l) ? o[l] : null);
    if (v) return v;
  }
  return '';
}

module.exports = { SUPPORTED, REPLI, langueDe, langueDeEntete, lireObjet, resoudre };
