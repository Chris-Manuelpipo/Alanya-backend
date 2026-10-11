/**
 * Textes localisés et chargement d'un pack — `node src/utils/stickerI18n.test.js`.
 */
const assert = require('assert');
const { resoudre, langueDe, langueDeEntete, lireObjet } = require('./stickerI18n');
const { construirePack, fusionner, PACK_MAX_STICKERS } = require('./stickerPackLoad');
const f = require('../testUtils/stickers/i18n-repli.json');

// ── Fixture du contrat : langue demandée → en → fr, vide = absent ──────────
for (const c of f.cas) assert.strictEqual(resoudre(f.entree, c.lang), c.attendu, `entree ${c.lang}`);
for (const c of f.cas2) assert.strictEqual(resoudre(f.entree2, c.lang), c.attendu, `entree2 ${c.lang}`);

// Variantes de langue et d'entrée
assert.strictEqual(resoudre(f.entree, 'zh-CN'), 'The Classics', 'zh-CN → zh (vide) → en');
assert.strictEqual(resoudre(f.entree, 'FR_ca'), 'Les Classiques');
assert.strictEqual(resoudre(f.entree, ''), 'The Classics', 'sans langue : en d\'abord');
assert.strictEqual(resoudre(f.entree, undefined), 'The Classics');
assert.strictEqual(resoudre({ fr: '   ', en: '' }, 'fr'), '', 'espaces = absent, rien à rendre');
assert.strictEqual(resoudre({ zh: '你好' }, 'en'), '', 'ni en ni fr : chaîne vide, jamais une autre langue');
assert.strictEqual(resoudre(null, 'fr'), '');
assert.strictEqual(resoudre('{"fr":"A","en":"B"}', 'en'), 'B', 'colonne JSON rendue en chaîne par le driver');
assert.strictEqual(resoudre('pas du json', 'fr'), '');
assert.strictEqual(resoudre('[1]', 'fr'), '');
assert.strictEqual(resoudre({ fr: 42 }, 'fr'), '', 'valeur non textuelle = absente');
// Pas de lecture sur le prototype
assert.strictEqual(resoudre({}, 'constructor'), '');
assert.deepStrictEqual(lireObjet([1]), {});

assert.strictEqual(langueDe('zh_CN'), 'zh');
assert.strictEqual(langueDeEntete('zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
assert.strictEqual(langueDeEntete('en-US'), 'en');
assert.strictEqual(langueDeEntete(undefined), '');
assert.strictEqual(langueDeEntete(['fr']), '');

// ── Fusion pack.json + i18n.json ───────────────────────────────────────────
const pack = {
  code: 'demo',
  nom: { fr: 'Démo' },
  premium: true,
  icone: 'b',
  stickers: [
    { fichier: 'a.webp', id: 'a', nom: 'Alpha', emoji: '👋' },
    { fichier: 'b.webp', id: 'b', nom: 'Bravo', emoji: '😂' },
    { fichier: 'c.webp', id: 'c', nom: 'Charlie', emoji: '🔥' },
  ],
};
const i18n = {
  packs: {
    demo: {
      nom: { fr: 'IGNORÉ', en: 'Demo', zh: '' },
      description: { fr: 'La démo', en: 'The demo', zh: '演示' },
      stickers: { a: { en: 'Alpha EN', zh: 'Alpha ZH' }, b: { en: 'Bravo EN', zh: '  ' } },
    },
  },
};
{
  const d = construirePack(pack, i18n);
  assert.deepStrictEqual(d.name_i18n, { fr: 'Démo', en: 'Demo' }, 'fr de pack.json fait foi ; zh vide non stocké');
  assert.deepStrictEqual(d.description_i18n, { fr: 'La démo', en: 'The demo', zh: '演示' });
  assert.strictEqual(d.is_premium, 1);
  assert.strictEqual(d.coverId, 'b');
  assert.deepStrictEqual(d.stickers.map((s) => s.position), [0, 1, 2]);
  assert.deepStrictEqual(d.stickers[0].name_i18n, { fr: 'Alpha', en: 'Alpha EN', zh: 'Alpha ZH' });
  assert.deepStrictEqual(d.stickers[1].name_i18n, { fr: 'Bravo', en: 'Bravo EN' });
  assert.deepStrictEqual(d.stickers[2].name_i18n, { fr: 'Charlie' }, 'sans traduction : français seul');
  // Repli à la lecture : la traduction manquante retombe sur en puis fr
  assert.strictEqual(resoudre(d.stickers[1].name_i18n, 'zh'), 'Bravo EN');
  assert.strictEqual(resoudre(d.stickers[2].name_i18n, 'zh'), 'Charlie');
  // Sans i18n.json du tout : français seul, description absente
  const seul = construirePack(pack, {});
  assert.deepStrictEqual(seul.name_i18n, { fr: 'Démo' });
  assert.strictEqual(seul.description_i18n, null);
  assert.strictEqual(construirePack({ ...pack, icone: undefined }, {}).coverId, 'a', 'icône par défaut : le premier');
}
assert.deepStrictEqual(fusionner('x', { fr: 'autre', en: ' y ' }), { fr: 'x', en: 'y' });

// ── Refus ───────────────────────────────────────────────────────────────────
const mauvais = (patch, motif) => assert.throws(
  () => construirePack({ ...pack, ...patch }, i18n), motif,
);
mauvais({ code: 'Bad Code' }, /code de pack invalide/);
mauvais({ code: '../x' }, /code de pack invalide/);
mauvais({ stickers: [] }, /sans sticker/);
mauvais({ nom: {} }, /nom français/);
mauvais({ icone: 'zz' }, /icône inconnue/);
mauvais({ stickers: [{ ...pack.stickers[0] }, { ...pack.stickers[0], fichier: 'x.webp' }] }, /en double/);
mauvais({ stickers: [{ ...pack.stickers[0], fichier: '../a.webp' }] }, /fichier invalide/);
mauvais({ stickers: [{ ...pack.stickers[0], fichier: 'a.png' }] }, /fichier invalide/);
mauvais({ stickers: [{ ...pack.stickers[0], emoji: '' }] }, /emoji invalide/);
mauvais({ stickers: [{ ...pack.stickers[0], emoji: 'x'.repeat(17) }] }, /emoji invalide/);
mauvais({ stickers: Array.from({ length: PACK_MAX_STICKERS + 1 }, (_, i) => ({ fichier: `s${i}.webp`, id: `s${i}`, nom: 'n', emoji: '😀' })), icone: undefined }, /40 au plus/);

console.log('stickerI18n.test.js : OK');
