const assert = require('assert');
const { buildBlockI18nRows } = require('./welcomeService');

/** Cherche une valeur par (locale, field). */
const find = (rows, locale, field) => {
  const hit = rows.find((r) => r[0] === locale && r[1] === field);
  return hit ? hit[2] : undefined;
};

// ── Provenance 1 : le bloc arrive de l'éditeur ───────────────────────
{
  const rows = buildBlockI18nRows({
    translations: { fr: 'Bienvenue', en: 'Welcome', zh: '欢迎' },
  });
  assert.strictEqual(find(rows, 'fr', 'content'), 'Bienvenue');
  assert.strictEqual(find(rows, 'en', 'content'), 'Welcome');
  assert.strictEqual(find(rows, 'zh', 'content'), '欢迎');
  assert.strictEqual(rows.length, 3);
}

// ── Provenance 2 : bloc relu en base, puis recopié ───────────────────
// C'est le cas qui transporte les traductions d'un identifiant de bloc au
// suivant. S'il régressait, publier ferait disparaître les traductions.
{
  const rows = buildBlockI18nRows({
    i18n: [
      { locale: 'fr', field: 'content', value: 'Bienvenue' },
      { locale: 'zh', field: 'content', value: '欢迎' },
      { locale: 'fr', field: 'cta.0', value: 'Compléter mon profil' },
    ],
  });
  assert.strictEqual(find(rows, 'fr', 'content'), 'Bienvenue');
  assert.strictEqual(find(rows, 'zh', 'content'), '欢迎');
  assert.strictEqual(find(rows, 'fr', 'cta.0'), 'Compléter mon profil');
}

// ── Provenance 3 : colonnes héritées, contenu antérieur à la 053 ─────
{
  const rows = buildBlockI18nRows({ contentFr: 'Bonjour', contentEn: 'Hello' });
  assert.strictEqual(find(rows, 'fr', 'content'), 'Bonjour');
  assert.strictEqual(find(rows, 'en', 'content'), 'Hello');
  // Aucune colonne chinoise n'existe : rien ne doit être inventé.
  assert.strictEqual(find(rows, 'zh', 'content'), undefined);
}

// ── Priorité : l'éditeur l'emporte sur le relu, qui l'emporte sur l'hérité ──
{
  const rows = buildBlockI18nRows({
    translations: { fr: 'Depuis éditeur' },
    i18n: [
      { locale: 'fr', field: 'content', value: 'Depuis base' },
      { locale: 'en', field: 'content', value: 'From db' },
    ],
    contentFr: 'Depuis colonne',
    contentEn: 'From column',
  });
  assert.strictEqual(find(rows, 'fr', 'content'), 'Depuis éditeur');
  // L'anglais n'est pas dans `translations` : le relu prend le relais avant
  // la colonne héritée.
  assert.strictEqual(find(rows, 'en', 'content'), 'From db');
  // Une seule ligne par (locale, field), jamais de doublon.
  const frContent = rows.filter((r) => r[0] === 'fr' && r[1] === 'content');
  assert.strictEqual(frContent.length, 1);
}

// ── Libellés de boutons, indexés par position ────────────────────────
// C'est ce qui sort les libellés de `cta_json`, où ils étaient codés en dur.
{
  const rows = buildBlockI18nRows({
    ctaJson: {
      buttons: [
        { labelFr: 'Compléter mon profil', labelEn: 'Complete my profile', action: 'route', target: 'profile' },
        { labelFr: 'Aide et FAQ', labelEn: 'Help and FAQ', action: 'route', target: 'help' },
      ],
    },
    ctaTranslations: [{ zh: '完善我的资料' }],
  });
  assert.strictEqual(find(rows, 'fr', 'cta.0'), 'Compléter mon profil');
  assert.strictEqual(find(rows, 'en', 'cta.0'), 'Complete my profile');
  assert.strictEqual(find(rows, 'zh', 'cta.0'), '完善我的资料');
  assert.strictEqual(find(rows, 'fr', 'cta.1'), 'Aide et FAQ');
  // Le second bouton n'a pas de chinois : rien n'est emprunté au premier.
  assert.strictEqual(find(rows, 'zh', 'cta.1'), undefined);
}

// ── Valeurs vides : ne comptent pas comme des traductions ────────────
{
  const rows = buildBlockI18nRows({
    translations: { fr: 'Bonjour', en: '   ', zh: null },
    contentEn: 'Hello',
  });
  // L'anglais vide de l'éditeur ne doit pas bloquer le repli sur la colonne.
  assert.strictEqual(find(rows, 'en', 'content'), 'Hello');
  assert.strictEqual(find(rows, 'zh', 'content'), undefined);
}

// ── Cas dégénérés ────────────────────────────────────────────────────
assert.deepStrictEqual(buildBlockI18nRows(null), []);
assert.deepStrictEqual(buildBlockI18nRows({}), []);
// Un bloc média sans texte ni bouton ne produit rien — légitime.
assert.deepStrictEqual(
  buildBlockI18nRows({ blockType: 'image', mediaUrl: 'https://x/y.jpg' }),
  [],
);

console.log('welcomeBlockI18n.test.js OK');
