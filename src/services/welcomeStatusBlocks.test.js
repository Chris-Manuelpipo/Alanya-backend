const assert = require('assert');
const { normalizeStatusBlock, statusBlockError } = require('./welcomeService');

/* ── Normalisation de ce qui arrive de l'éditeur ─────────────────────── */
{
  const block = normalizeStatusBlock(
    {
      id: 7,
      type: 1,
      translations: { fr: '  Bonjour  ', en: 'Hello', zh: '   ' },
      mediaUrl: 'https://cdn/x.jpg',
      backgroundColor: '1a237e',
    },
    3,
  );
  assert.strictEqual(block.id, 7);
  // La position vient du rang dans le tableau, jamais de ce que dit le client :
  // deux éléments prétendant au même `sortOrder` rendraient l'ordre instable.
  assert.strictEqual(block.sortOrder, 3);
  assert.strictEqual(block.type, 1);
  assert.strictEqual(block.translations.fr, 'Bonjour');
  // Une traduction blanche n'est pas une traduction.
  assert.strictEqual(block.translations.zh, undefined);
  assert.strictEqual(block.backgroundColor, '#1A237E');
}

// Élément neuf : pas d'identifiant, type par défaut, média absent.
{
  const block = normalizeStatusBlock({}, 0);
  assert.strictEqual(block.id, null);
  assert.strictEqual(block.type, 0);
  assert.strictEqual(block.mediaUrl, null);
  assert.strictEqual(block.backgroundColor, null);
}

// Un type inconnu retombe sur « texte » plutôt que d'atteindre la base.
assert.strictEqual(normalizeStatusBlock({ type: 9 }, 0).type, 0);
assert.strictEqual(normalizeStatusBlock({ type: '2' }, 0).type, 2);

// Texte trop long : refusé à la porte, `statut.text` est un TINYTEXT.
assert.throws(
  () => normalizeStatusBlock({ translations: { fr: 'x'.repeat(201) } }, 0),
  /200 caractères/,
);

/* ── Ce qui empêche un élément d'être livré ──────────────────────────── */
const ok = (raw, index = 0) => statusBlockError(normalizeStatusBlock(raw, index), index);

// Complet.
assert.strictEqual(ok({ translations: { fr: 'Bonjour', en: 'Hello' } }), null);
assert.strictEqual(
  ok({ type: 1, mediaUrl: 'https://cdn/x.jpg' }),
  null,
  'une image sans légende est légitime',
);

// Statut texte sans français : le français est la langue de base du contenu.
assert.match(ok({ translations: { en: 'Hello' } }), /Élément 1 .*français/);

// Traduction requise manquante — numérotée comme dans l'éditeur.
assert.match(ok({ translations: { fr: 'Bonjour' } }, 2), /Élément 3 .*EN/);

// Une légende d'image traduite à moitié compte aussi : sans l'anglais,
// l'anglophone verrait la légende française sous l'image.
assert.match(
  ok({ type: 1, mediaUrl: 'https://cdn/x.jpg', translations: { fr: 'Légende' } }),
  /traduction manquante/,
);

// Média obligatoire pour une image ou une vidéo.
assert.match(ok({ type: 1 }), /image exige un média/);
assert.match(ok({ type: 2 }), /vidéo exige un média/);

console.log('welcomeStatusBlocks.test.js OK');
