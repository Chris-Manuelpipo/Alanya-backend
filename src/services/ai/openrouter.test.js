const assert = require('assert');
const { extractJson, currentModel, isConfigured, DEFAULT_MODEL } = require('./openrouter');

/* ── Extraction du JSON ──────────────────────────────────────────────── */
// Toute la robustesse du client tient là : le catalogue OpenRouter n'offre pas
// de sortie structurée universelle, donc le JSON est demandé dans la consigne
// et récupéré ici. Ce qui est toléré ici est exactement ce qu'un modèle
// bavard peut produire sans qu'on ait à le changer.

{
  const o = extractJson('{"translations":{"en":"Hello"}}');
  assert.strictEqual(o.translations.en, 'Hello');
}

// Bloc de code : le cas le plus fréquent, et celui qui ferait échouer un
// JSON.parse direct.
{
  const o = extractJson('```json\n{"a":1}\n```');
  assert.strictEqual(o.a, 1);
}

// Phrase d'introduction, puis l'objet.
{
  const o = extractJson('Voici la traduction demandée :\n{"a":2}');
  assert.strictEqual(o.a, 2);
}

// Bavardage après l'objet — l'accolade fermante suffit à s'arrêter.
{
  const o = extractJson('{"a":3}\n\nJ\'espère que cela convient !');
  assert.strictEqual(o.a, 3);
}

// Une accolade **dans une chaîne** ne ferme pas l'objet. C'est le piège que
// le comptage naïf ne voit pas, et il arrive : le balisage `#manuscrit#` et
// les traductions techniques charrient des accolades.
{
  const o = extractJson('{"en":"use } carefully","zh":"好"}');
  assert.strictEqual(o.en, 'use } carefully');
  assert.strictEqual(o.zh, '好');
}

// Guillemet échappé : la chaîne ne s'y termine pas, donc l'accolade qui suit
// reste à l'intérieur.
{
  const o = extractJson('{"en":"say \\"hi } there\\" now"}');
  assert.strictEqual(o.en, 'say "hi } there" now');
}

// Objets imbriqués : c'est la forme réelle de la réponse de traduction.
{
  const o = extractJson('{"translations":{"en":"A","zh":"B"},"notes":[]}');
  assert.deepStrictEqual(o.translations, { en: 'A', zh: 'B' });
  assert.deepStrictEqual(o.notes, []);
}

assert.throws(() => extractJson(''), /vide/);
assert.throws(() => extractJson('   '), /vide/);
assert.throws(() => extractJson('désolé, je ne peux pas'), /aucun objet/);
// Coupé par max_tokens : mieux vaut lever et relancer que rendre un objet
// partiel qui écraserait une saisie par une demi-traduction.
assert.throws(() => extractJson('{"a":1'), /non refermé/);

/* ── Configuration ───────────────────────────────────────────────────── */
{
  const cleAvant = process.env.OPENROUTER_API_KEY;
  const modeleAvant = process.env.OPENROUTER_MODEL;

  delete process.env.OPENROUTER_API_KEY;
  assert.strictEqual(isConfigured(), false, 'sans clé, le service est indisponible');
  process.env.OPENROUTER_API_KEY = '   ';
  assert.strictEqual(isConfigured(), false, 'une clé blanche n’est pas une clé');
  process.env.OPENROUTER_API_KEY = 'sk-test';
  assert.strictEqual(isConfigured(), true);

  delete process.env.OPENROUTER_MODEL;
  assert.strictEqual(currentModel(), DEFAULT_MODEL);
  process.env.OPENROUTER_MODEL = 'qwen/qwen-2.5-72b-instruct';
  assert.strictEqual(currentModel(), 'qwen/qwen-2.5-72b-instruct',
    'changer de modèle doit rester une variable d’environnement');

  if (cleAvant === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = cleAvant;
  if (modeleAvant === undefined) delete process.env.OPENROUTER_MODEL;
  else process.env.OPENROUTER_MODEL = modeleAvant;
}

console.log('openrouter.test.js OK');
