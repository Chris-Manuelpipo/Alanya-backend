const assert = require('assert');
const {
  normalizeKind,
  normalizeSource,
  normalizeTargets,
  normalizeSourceLocale,
  sanitizeTranslations,
  KINDS,
  SOURCE_MAX,
  PUSH_BODY_MAX,
} = require('./editorialAssist');
const { SUPPORTED_CONTENT_LOCALES } = require('../../utils/localeContent');

/* ── Nature du contenu ───────────────────────────────────────────────── */
// Le ton d'un libellé de bouton n'a rien à voir avec celui d'une annonce :
// une nature inconnue produirait un prompt générique, donc des boutons en
// phrases complètes. Elle est refusée plutôt que repliée sur une valeur par
// défaut.
assert.strictEqual(normalizeKind('WELCOME'), 'welcome');
assert.strictEqual(normalizeKind('  cta  '), 'cta');
assert.throws(() => normalizeKind('article'), /Nature/);
assert.throws(() => normalizeKind(''), /Nature/);
assert.throws(() => normalizeKind(null), /Nature/);
// Une clé héritée d'Object ne doit pas passer pour une nature.
assert.throws(() => normalizeKind('constructor'), /Nature/);

// Chaque nature porte de quoi construire la consigne — sans quoi le prompt
// contiendrait « undefined ».
for (const [nom, meta] of Object.entries(KINDS)) {
  assert.ok(meta.label && meta.guidance, `${nom} doit porter label et guidance`);
}

/* ── Texte source ────────────────────────────────────────────────────── */
assert.strictEqual(normalizeSource('  Bonjour  '), 'Bonjour');
assert.throws(() => normalizeSource(''), /vide/);
assert.throws(() => normalizeSource('   \n  '), /vide/);
assert.throws(() => normalizeSource(null), /vide/);
// Tronquer et non refuser : l'administrateur récupère une traduction partielle
// qu'il complète, au lieu d'un refus qui ne lui dit pas quoi couper.
assert.strictEqual(normalizeSource('x'.repeat(SOURCE_MAX + 500)).length, SOURCE_MAX);

/* ── Langue source ───────────────────────────────────────────────────── */
assert.strictEqual(normalizeSourceLocale(undefined), 'fr', 'le français est la langue de rédaction');
assert.strictEqual(normalizeSourceLocale('en-US'), 'en');
assert.strictEqual(normalizeSourceLocale('ZH'), 'zh');
// `supportedLocale` écarte au lieu de replier : une langue inconnue en source
// ne doit pas devenir « fr » en silence, sinon on traduit le mauvais texte.
assert.throws(() => normalizeSourceLocale('pt'), /Langue source/);

/* ── Langues cibles ──────────────────────────────────────────────────── */
// Sans liste : tout ce qui est supporté sauf la source. C'est le cas courant —
// on écrit le français et on veut le reste.
assert.deepStrictEqual(
  normalizeTargets(undefined, 'fr'),
  SUPPORTED_CONTENT_LOCALES.filter((l) => l !== 'fr'),
);
assert.deepStrictEqual(normalizeTargets([], 'fr'), ['en', 'zh']);
assert.deepStrictEqual(normalizeTargets(['zh'], 'fr'), ['zh']);
assert.deepStrictEqual(normalizeTargets(['ZH', 'en-GB'], 'fr'), ['zh', 'en']);
// Les doublons ne doivent pas faire payer deux fois la même langue.
assert.deepStrictEqual(normalizeTargets(['en', 'en'], 'fr'), ['en']);

// La langue source est toujours écartée, même demandée : une « traduction »
// du français vers le français écraserait la saisie d'origine par une
// paraphrase, ce que personne n'a demandé en cliquant sur Traduire.
assert.deepStrictEqual(normalizeTargets(['fr', 'en'], 'fr'), ['en']);
assert.throws(() => normalizeTargets(['fr'], 'fr'), /Aucune langue cible/);

assert.throws(() => normalizeTargets(['pt'], 'fr'), /non supportée/);
assert.throws(() => normalizeTargets('en', 'fr'), /invalides/);

/* ── Nettoyage du retour du modèle ───────────────────────────────────── */
// Une langue absente, vide ou d'un mauvais type doit ressortir *manquante* —
// l'éditeur la signale déjà comme il signale une traduction non saisie. Écrire
// une valeur bancale dans le brouillon serait pire que ne rien écrire.
{
  const { translations, missing } = sanitizeTranslations(
    { en: '  Hello  ', zh: '', extra: 'ignoré' },
    ['en', 'zh'],
  );
  assert.deepStrictEqual(translations, { en: 'Hello' });
  assert.deepStrictEqual(missing, ['zh'], 'une chaîne vide est une traduction manquante');
}
{
  // Le modèle a renvoyé un objet là où un texte était attendu.
  const { translations, missing } = sanitizeTranslations({ en: { text: 'Hello' } }, ['en']);
  assert.deepStrictEqual(translations, {});
  assert.deepStrictEqual(missing, ['en']);
}
{
  // Aucune traduction du tout, ou un `translations` absent de la réponse.
  assert.deepStrictEqual(sanitizeTranslations(undefined, ['en', 'zh']).missing, ['en', 'zh']);
  assert.deepStrictEqual(sanitizeTranslations(null, ['en']).translations, {});
}
{
  // Une langue rendue mais non demandée n'entre pas dans le brouillon : le
  // formulaire n'a pas de champ pour elle.
  const { translations } = sanitizeTranslations({ en: 'Hello', zh: '好' }, ['en']);
  assert.deepStrictEqual(translations, { en: 'Hello' });
}

/* ── Contraintes reprises d'ailleurs ─────────────────────────────────── */
// Miroir de `broadcastService.js` (`slice(0, 120)`) : si la troncature change
// là-bas, le modèle doit apprendre la nouvelle limite ici.
assert.strictEqual(PUSH_BODY_MAX, 120);
assert.ok(
  KINDS.broadcast.guidance.includes(String(PUSH_BODY_MAX)),
  'la consigne « annonce » doit nommer la limite du push',
);

console.log('editorialAssist.test.js OK');
