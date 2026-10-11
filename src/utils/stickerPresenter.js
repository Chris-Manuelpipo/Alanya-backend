/**
 * Mise en forme des réponses `/api/stickers/*` — pure, sans base : les lignes
 * SQL entrent, la forme du contrat (fixtures `catalog.json`, `pack.json`,
 * `me.json`) sort. Les clés sont celles des fixtures ; tout champ ajouté est
 * ignorable par un client plus ancien (AGENTS.md).
 */

const { resoudre } = require('./stickerI18n');

/**
 * Packs que l'application installe d'office. Aucune colonne ne le porte
 * (schéma §5) : c'est une décision d'exploitation, d'où la constante ici.
 */
const PACKS_INSTALLES_PAR_DEFAUT = Object.freeze(['alanya']);

const bool = (v) => Number(v) === 1;

/**
 * @param {object} p
 * @param {Array}  p.packs   lignes `sticker_pack` + `count` + `cover_thumb_key`
 * @param {number} p.version version du catalogue
 * @param {string} p.lang
 * @param {(key: string) => string} p.urlDe
 * @param {boolean} p.verrouille  vrai si le compte n'a PAS le droit Plus
 */
function presentCatalog({ packs, version, lang, urlDe, verrouille }) {
  return {
    version: Number(version) || 0,
    packs: packs.map((p) => ({
      id: Number(p.id),
      code: p.code,
      name: resoudre(p.name_i18n, lang),
      description: resoudre(p.description_i18n, lang),
      cover: p.cover_thumb_key ? urlDe(p.cover_thumb_key) : null,
      count: Number(p.count) || 0,
      isPremium: bool(p.is_premium),
      locked: bool(p.is_premium) && Boolean(verrouille),
      version: Number(p.version) || 1,
      installedByDefault: PACKS_INSTALLES_PAR_DEFAUT.includes(p.code),
    })),
  };
}

function presentPack({ pack, stickers, lang, urlDe, verrouille }) {
  return {
    id: Number(pack.id),
    code: pack.code,
    name: resoudre(pack.name_i18n, lang),
    description: resoudre(pack.description_i18n, lang),
    version: Number(pack.version) || 1,
    isPremium: bool(pack.is_premium),
    locked: bool(pack.is_premium) && Boolean(verrouille),
    stickers: stickers.map((s) => ({
      id: Number(s.id),
      position: Number(s.position),
      emoji: s.emoji,
      name: resoudre(s.name_i18n, lang),
      url: urlDe(s.storage_key),
      thumb: urlDe(s.thumb_key || s.storage_key),
      w: Number(s.width) || 512,
      h: Number(s.height) || 512,
      animated: bool(s.animated),
      bytes: Number(s.bytes) || 0,
    })),
  };
}

/** Ids seulement (contrat §4) : le client résout le reste par le catalogue. */
function presentMe({ packs, favorites, version }) {
  return {
    version: Number(version) || 0,
    packs: packs.map((p) => ({ id: Number(p.id), code: p.code, position: Number(p.position) })),
    favorites: favorites.map((f) => Number(f)),
  };
}

module.exports = { PACKS_INSTALLES_PAR_DEFAUT, presentCatalog, presentPack, presentMe };
