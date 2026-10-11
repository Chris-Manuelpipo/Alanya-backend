/**
 * Lecture d'un pack exporté (`stickers-export/<pack>/pack.json`) fusionnée
 * avec `stickers-export/i18n.json` — pure, sans entrée-sortie : le script
 * `scripts/load_sticker_pack.js` lit les fichiers, cette fonction décide.
 *
 * Le français vient de `pack.json` (référence). L'anglais et le chinois
 * viennent de `i18n.json`. Une traduction absente ou vide n'est PAS stockée :
 * le repli (langue demandée → `en` → `fr`) se fait à la lecture, dans
 * `utils/stickerI18n`, si bien qu'une traduction ajoutée plus tard prend effet
 * sans rechargement et qu'`en` garde son rôle de repli pour `zh`.
 */

const PACK_MAX_STICKERS = 40;
const EMOJI_MAX = 16;
const CODE_PACK = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const NOM_FICHIER = /^[A-Za-z0-9_-]+\.webp$/;

const texte = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Garde les langues non vides, `fr` en tête. */
function fusionner(fr, traductions) {
  const sortie = {};
  const f = texte(fr);
  if (f) sortie.fr = f;
  for (const [langue, valeur] of Object.entries(traductions || {})) {
    if (langue === 'fr' && sortie.fr) continue; // pack.json fait foi pour le français
    const v = texte(valeur);
    if (v) sortie[langue] = v;
  }
  return sortie;
}

/**
 * @param {object} pack  contenu de `pack.json`
 * @param {object} i18n  contenu de `i18n.json` (peut être `{}`)
 * @throws {Error} pack invalide (message en français, pour l'opérateur)
 */
function construirePack(pack, i18n = {}) {
  if (!pack || typeof pack !== 'object') throw new Error('pack.json illisible');
  if (!CODE_PACK.test(String(pack.code || ''))) throw new Error(`code de pack invalide : ${pack.code}`);
  if (!Array.isArray(pack.stickers) || pack.stickers.length === 0) throw new Error('pack sans sticker');
  if (pack.stickers.length > PACK_MAX_STICKERS) {
    throw new Error(`${pack.stickers.length} stickers : ${PACK_MAX_STICKERS} au plus par pack`);
  }
  const t = (i18n.packs && i18n.packs[pack.code]) || {};
  const nomFr = texte(pack.nom && pack.nom.fr);
  if (!nomFr) throw new Error('nom français du pack manquant');

  const ids = new Set();
  const fichiers = new Set();
  const stickers = pack.stickers.map((s, i) => {
    if (!s || !texte(s.id)) throw new Error(`sticker ${i} sans id`);
    if (ids.has(s.id)) throw new Error(`id de sticker en double : ${s.id}`);
    ids.add(s.id);
    if (!NOM_FICHIER.test(String(s.fichier || ''))) throw new Error(`fichier invalide pour ${s.id} : ${s.fichier}`);
    if (fichiers.has(s.fichier)) throw new Error(`fichier en double : ${s.fichier}`);
    fichiers.add(s.fichier);
    const emoji = texte(s.emoji);
    if (!emoji || emoji.length > EMOJI_MAX) throw new Error(`emoji invalide pour ${s.id}`);
    const trad = (t.stickers && t.stickers[s.id]) || {};
    return {
      id: s.id,
      fichier: s.fichier,
      position: i,
      emoji,
      name_i18n: fusionner(s.nom, { en: trad.en, zh: trad.zh, fr: trad.fr }),
    };
  });
  if (pack.icone && !ids.has(pack.icone)) throw new Error(`icône inconnue : ${pack.icone}`);

  const description = fusionner(
    t.description && t.description.fr,
    { en: t.description && t.description.en, zh: t.description && t.description.zh },
  );

  return {
    code: pack.code,
    name_i18n: fusionner(nomFr, { en: t.nom && t.nom.en, zh: t.nom && t.nom.zh }),
    description_i18n: Object.keys(description).length ? description : null,
    is_premium: pack.premium === true ? 1 : 0,
    coverId: pack.icone || stickers[0].id,
    stickers,
  };
}

module.exports = { PACK_MAX_STICKERS, fusionner, construirePack };
