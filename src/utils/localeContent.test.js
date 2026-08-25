const assert = require('assert');
const {
  SUPPORTED_CONTENT_LOCALES,
  normalizeLocale,
  resolveI18n,
  pickLocalized,
  untranslatedRequiredLocales,
  defaultBroadcastPushBody,
} = require('./localeContent');

// ── normalizeLocale : l'entonnoir est levé ───────────────────────────
// Avant la migration 053, tout ce qui ne commençait pas par `en` retombait sur
// `fr` : un utilisateur chinois recevait les annonces en français.
assert.strictEqual(normalizeLocale('fr'), 'fr');
assert.strictEqual(normalizeLocale('en'), 'en');
assert.strictEqual(normalizeLocale('zh'), 'zh');
assert.strictEqual(normalizeLocale('zh-Hans'), 'zh');
assert.strictEqual(normalizeLocale('en_US'), 'en');
assert.strictEqual(normalizeLocale('EN'), 'en');
// Inconnu ou absent → français, comme avant.
assert.strictEqual(normalizeLocale('ko'), 'fr');
assert.strictEqual(normalizeLocale(null), 'fr');
assert.strictEqual(normalizeLocale(''), 'fr');
// Le portugais est reporté : il ne doit PAS être accepté tant qu'il n'est pas
// dans la liste, sinon on promettrait un contenu que personne ne saisit.
assert.strictEqual(normalizeLocale('pt'), 'fr');
assert.ok(!SUPPORTED_CONTENT_LOCALES.includes('pt'));

// ── resolveI18n : chaîne de repli ────────────────────────────────────
const rows = [
  { locale: 'fr', content: 'Bonjour' },
  { locale: 'en', content: 'Hello' },
  { locale: 'zh', content: '你好' },
];

assert.strictEqual(resolveI18n(rows, 'zh'), '你好');
assert.strictEqual(resolveI18n(rows, 'fr'), 'Bonjour');

// Chinois absent → anglais, PAS français : on descend vers la langue la plus
// largement comprise avant de retomber sur l'original.
const noZh = rows.filter((r) => r.locale !== 'zh');
assert.strictEqual(resolveI18n(noZh, 'zh'), 'Hello');

// Anglais absent aussi → français.
assert.strictEqual(resolveI18n([{ locale: 'fr', content: 'Bonjour' }], 'zh'), 'Bonjour');

// Une valeur vide ne compte pas comme une traduction : on continue la chaîne.
assert.strictEqual(
  resolveI18n([{ locale: 'zh', content: '   ' }, { locale: 'en', content: 'Hello' }], 'zh'),
  'Hello',
);

// Dernier maillon : une seule langue, hors chaîne de repli — mieux vaut
// l'afficher qu'une chaîne vide.
assert.strictEqual(
  resolveI18n([{ locale: 'zh', content: '你好' }], 'fr'),
  '你好',
);

assert.strictEqual(resolveI18n([], 'fr'), null);
assert.strictEqual(resolveI18n(null, 'fr'), null);

// ── resolveI18n : filtrage par champ (blocs de bienvenue) ────────────
// `field` distingue le corps du bloc des libellés de boutons, désormais sortis
// de `cta_json`.
const blockRows = [
  { locale: 'fr', field: 'content', value: 'Bienvenue' },
  { locale: 'en', field: 'content', value: 'Welcome' },
  { locale: 'fr', field: 'cta.0', value: 'Compléter mon profil' },
  { locale: 'en', field: 'cta.0', value: 'Complete my profile' },
  { locale: 'fr', field: 'cta.1', value: 'Aide et FAQ' },
];

assert.strictEqual(
  resolveI18n(blockRows, 'en', { valueKey: 'value', field: 'content' }),
  'Welcome',
);
assert.strictEqual(
  resolveI18n(blockRows, 'fr', { valueKey: 'value', field: 'cta.0' }),
  'Compléter mon profil',
);
// Bouton 1 sans version anglaise → repli sur le français.
assert.strictEqual(
  resolveI18n(blockRows, 'en', { valueKey: 'value', field: 'cta.1' }),
  'Aide et FAQ',
);
// Un champ inexistant ne doit pas emprunter la valeur d'un autre bouton.
assert.strictEqual(
  resolveI18n(blockRows, 'fr', { valueKey: 'value', field: 'cta.9' }),
  null,
);

// ── pickLocalized : lecture héritée pendant la double écriture ───────
const legacy = { content: 'Bonjour', content_en: 'Hello' };
assert.strictEqual(pickLocalized(legacy, 'fr', 'content'), 'Bonjour');
assert.strictEqual(pickLocalized(legacy, 'en', 'content'), 'Hello');
// Le chinois n'a pas de colonne dédiée : il emprunte l'anglais plutôt que le
// français, cohérent avec la chaîne de repli.
assert.strictEqual(pickLocalized(legacy, 'zh', 'content'), 'Hello');
// Convention camelCase des blocs de bienvenue (mapBlockRow).
assert.strictEqual(
  pickLocalized({ contentFr: 'Salut', contentEn: 'Hi' }, 'en', 'content'),
  'Hi',
);
// Anglais vide → français, sans quoi le message de bienvenue s'affichait vide.
assert.strictEqual(
  pickLocalized({ content: 'Bonjour', content_en: '  ' }, 'en', 'content'),
  'Bonjour',
);

// ── untranslatedRequiredLocales : ce qui bloque une publication ──────
// Rien de saisi : rien n'est dû — une légende absente est légitime sur un bloc
// image, et l'exiger bloquerait la publication pour un champ facultatif.
assert.deepStrictEqual(untranslatedRequiredLocales({}), []);
assert.deepStrictEqual(untranslatedRequiredLocales(null), []);
assert.deepStrictEqual(untranslatedRequiredLocales({ fr: '  ', en: '' }), []);
// Dès qu'une langue est saisie, les langues requises le deviennent toutes —
// dans les deux sens : un texte écrit d'abord en anglais réclame le français.
assert.deepStrictEqual(untranslatedRequiredLocales({ fr: 'Bonjour' }), ['en']);
assert.deepStrictEqual(untranslatedRequiredLocales({ en: 'Hello' }), ['fr']);
// Une langue facultative suffit à déclencher l'exigence : sans cela, un bloc
// saisi en chinois seul partait sans français ni anglais.
assert.deepStrictEqual(untranslatedRequiredLocales({ zh: '欢迎' }), ['fr', 'en']);
assert.deepStrictEqual(
  untranslatedRequiredLocales({ fr: 'Bonjour', en: 'Hello', zh: '欢迎' }),
  [],
);

// ── defaultBroadcastPushBody ─────────────────────────────────────────
assert.strictEqual(defaultBroadcastPushBody(0, 'fr'), 'Nouvelle annonce');
assert.strictEqual(defaultBroadcastPushBody(1, 'fr'), 'Nouveau statut');
assert.strictEqual(defaultBroadcastPushBody(0, 'en'), 'New announcement');
assert.strictEqual(defaultBroadcastPushBody(1, 'zh'), '新动态');
assert.strictEqual(defaultBroadcastPushBody(0, 'zh'), '新公告');
// Locale inconnue → français.
assert.strictEqual(defaultBroadcastPushBody(0, 'ko'), 'Nouvelle annonce');

console.log('localeContent.test.js OK');
