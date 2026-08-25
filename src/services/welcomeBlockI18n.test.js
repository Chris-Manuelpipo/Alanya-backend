const assert = require('assert');
const {
  buildBlockI18nRows,
  attachBlockTranslations,
  legacyContentColumns,
} = require('./welcomeService');

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

// ── Vider un champ dans l'éditeur efface la traduction ───────────────
// Une locale *présente* mais vide est une suppression demandée : aucune
// provenance ultérieure ne doit la repeupler. Tant que la valeur vide était
// simplement ignorée, effacer un texte dans l'administration était sans effet —
// l'ancienne traduction revenait à l'enregistrement suivant.
{
  const rows = buildBlockI18nRows({
    translations: { fr: 'Bonjour', en: '   ', zh: null },
    i18n: [{ locale: 'en', field: 'content', value: 'From db' }],
    contentEn: 'Hello',
  });
  assert.strictEqual(find(rows, 'fr', 'content'), 'Bonjour');
  assert.strictEqual(find(rows, 'en', 'content'), undefined);
  assert.strictEqual(find(rows, 'zh', 'content'), undefined);
}

// ── Locale absente ≠ locale vidée ────────────────────────────────────
// Sans la clé, l'éditeur n'a rien dit : les provenances suivantes jouent.
{
  const rows = buildBlockI18nRows({
    translations: { fr: 'Bonjour' },
    contentEn: 'Hello',
  });
  assert.strictEqual(find(rows, 'en', 'content'), 'Hello');
}

// ── Un libellé de bouton vidé disparaît aussi ────────────────────────
{
  const rows = buildBlockI18nRows({
    ctaJson: { buttons: [{ labelFr: 'Ancien', labelEn: 'Old', action: 'route', target: 'profile' }] },
    ctaTranslations: [{ fr: 'Nouveau', en: '' }],
  });
  assert.strictEqual(find(rows, 'fr', 'cta.0'), 'Nouveau');
  assert.strictEqual(find(rows, 'en', 'cta.0'), undefined);
}

// ── Reliquat d'un bouton supprimé : ne se recopie pas ────────────────
{
  const rows = buildBlockI18nRows({
    ctaJson: { buttons: [{ labelFr: 'Seul', labelEn: 'Alone', action: 'route', target: 'help' }] },
    i18n: [
      { locale: 'fr', field: 'cta.0', value: 'Seul' },
      { locale: 'fr', field: 'cta.3', value: 'Bouton supprimé' },
    ],
  });
  assert.strictEqual(find(rows, 'fr', 'cta.0'), 'Seul');
  assert.strictEqual(find(rows, 'fr', 'cta.3'), undefined);
}

// ── Aucun bouton lisible : on ne nettoie rien ────────────────────────
// `mapBlockRow` met `ctaJson` à null quand le JSON est illisible. Nettoyer sur
// cette base effacerait définitivement des libellés valides.
{
  const rows = buildBlockI18nRows({
    ctaJson: null,
    i18n: [{ locale: 'fr', field: 'cta.0', value: 'Libellé rescapé' }],
  });
  assert.strictEqual(find(rows, 'fr', 'cta.0'), 'Libellé rescapé');
}

// ── Relecture : la forme éditeur est reconstruite depuis `welcome_block_i18n` ──
// C'est ce que l'API ne renvoyait pas : l'éditeur lisait `translations` sur une
// réponse qui n'en portait pas, et ouvrait des champs vides sur un contenu
// pourtant intact en base.
{
  const block = attachBlockTranslations({
    blockType: 'cta',
    contentFr: 'Hérité fr',
    contentEn: 'Hérité en',
    ctaJson: {
      buttons: [
        { labelFr: 'Ancien libellé', labelEn: 'Old label', action: 'url', target: 'https://x' },
        { labelFr: 'Sans i18n', labelEn: 'No i18n', action: 'route', target: 'help' },
      ],
    },
    i18n: [
      { locale: 'fr', field: 'content', value: 'Depuis la table' },
      { locale: 'zh', field: 'content', value: '来自数据表' },
      { locale: 'fr', field: 'cta.0', value: 'Visitez Alanya' },
      { locale: 'en', field: 'cta.0', value: 'Visit Alanya' },
      // Reliquat d'un bouton supprimé : ne doit ressusciter nulle part.
      { locale: 'fr', field: 'cta.7', value: 'Bouton disparu' },
      // Locale non supportée : `normalizeLocale` la replierait sur `fr` et
      // écraserait le français.
      { locale: 'pt', field: 'content', value: 'Português' },
    ],
  });

  assert.strictEqual(block.translations.fr, 'Depuis la table');
  assert.strictEqual(block.translations.zh, '来自数据表');
  // L'anglais n'est pas dans la table : la colonne héritée prend le relais.
  assert.strictEqual(block.translations.en, 'Hérité en');
  assert.strictEqual(block.ctaTranslations.length, 2);
  assert.deepStrictEqual(block.ctaTranslations[0], { fr: 'Visitez Alanya', en: 'Visit Alanya' });
  assert.deepStrictEqual(block.ctaTranslations[1], { fr: 'Sans i18n', en: 'No i18n' });
}

// ── Bloc antérieur à la 053 : les colonnes héritées suffisent ────────
{
  const block = attachBlockTranslations({
    blockType: 'text',
    contentFr: 'Bonjour',
    contentEn: 'Hello',
    i18n: [],
  });
  assert.deepStrictEqual(block.translations, { fr: 'Bonjour', en: 'Hello' });
  assert.deepStrictEqual(block.ctaTranslations, []);
}

// ── Colonnes héritées : dérivées de ce qui part dans la table ────────
// Recopier le `contentFr` reçu de l'éditeur laissait la colonne sur l'ancien
// texte pendant que la table normalisée recevait le nouveau.
{
  assert.deepStrictEqual(
    legacyContentColumns({
      translations: { fr: 'Nouveau texte', en: 'New text' },
      contentFr: 'Ancien texte',
      contentEn: 'Old text',
    }),
    ['Nouveau texte', 'New text'],
  );
  // Champ vidé : la colonne se vide avec la table.
  assert.deepStrictEqual(
    legacyContentColumns({ translations: { fr: 'Seul le fr', en: '' }, contentEn: 'Old text' }),
    ['Seul le fr', ''],
  );
  assert.deepStrictEqual(legacyContentColumns({ blockType: 'image' }), ['', '']);
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
