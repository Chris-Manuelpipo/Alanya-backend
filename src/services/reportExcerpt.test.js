/**
 * `node src/services/reportExcerpt.test.js`
 *
 * L'extrait joint à un signalement est la seule chose qui empêche la
 * modération des messages de s'arrêter net le jour où le chiffrement
 * s'allume : le serveur ne peut plus ouvrir le corps, et la personne qui
 * modère devrait sinon trancher sur la foi du seul motif choisi.
 *
 * Mais c'est aussi du clair qui remonte vers le serveur. Les deux bornes
 * testées ici — nombre de messages de contexte, longueur de chacun — sont ce
 * qui empêche le champ de devenir une porte de lecture : sans elles, un
 * client pourrait faire remonter un fil entier sous couvert de signalement,
 * l'inverse exact de ce que le chiffrement garantit.
 *
 * Module pur : ces deux fonctions ne touchent pas la base, contrairement à
 * `createReport`. Elles sont donc vérifiables sans MySQL et sans migration.
 */

const assert = require('assert');
const {
  EXCERPT_MAX,
  CONTEXT_MAX,
  CONTEXT_TEXT_MAX,
  normalizeExcerpt,
  normalizeContext,
} = require('./reportService');

// ── L'extrait du message signalé ──────────────────────────────────────────

assert.strictEqual(normalizeExcerpt('  insulte  '), 'insulte');

// Rien de fourni : `null`, et le signalement reste recevable. Un client trop
// ancien ne joint pas d'extrait, et refuser sa plainte serait punir la
// personne qui signale pour une mise à jour qu'elle n'a pas faite.
assert.strictEqual(normalizeExcerpt(null), null);
assert.strictEqual(normalizeExcerpt(undefined), null);
assert.strictEqual(normalizeExcerpt(''), null);
assert.strictEqual(normalizeExcerpt('   '), null);

// Tronquer plutôt que refuser : personne ne doit perdre son signalement parce
// que le message visé était bavard.
const long = 'x'.repeat(EXCERPT_MAX + 500);
assert.strictEqual(normalizeExcerpt(long).length, EXCERPT_MAX);
assert.strictEqual(normalizeExcerpt('x'.repeat(EXCERPT_MAX)).length, EXCERPT_MAX);

// ── Le contexte ───────────────────────────────────────────────────────────

const unMessage = (i) => ({ senderID: 5, sendAt: '2026-10-02T08:00:00Z', text: `m${i}` });

const ctx = normalizeContext([unMessage(1), unMessage(2)]);
assert.strictEqual(ctx.length, 2);
assert.deepStrictEqual(ctx[0], {
  senderID: 5, sendAt: '2026-10-02T08:00:00Z', text: 'm1',
});

// LA borne qui compte : au-delà de cinq messages, c'est le fil entier qui
// remonterait en clair vers le serveur. On garde les CINQ DERNIERS, pas les
// cinq premiers : ce sont ceux qui précèdent immédiatement le message
// signalé, donc les seuls qui l'éclairent.
const trop = normalizeContext(
  Array.from({ length: CONTEXT_MAX + 7 }, (_, i) => unMessage(i)),
);
assert.strictEqual(trop.length, CONTEXT_MAX, `au plus ${CONTEXT_MAX} messages de contexte`);
assert.strictEqual(
  trop[trop.length - 1].text, `m${CONTEXT_MAX + 6}`,
  'ce sont les derniers messages qui sont gardés, pas les premiers',
);

// Seconde borne : chaque message est tronqué. Cinq messages sans borne de
// longueur, ce sont cinq messages entiers — la borne en nombre ne suffit pas.
const bavard = normalizeContext([{ senderID: 5, text: 'y'.repeat(CONTEXT_TEXT_MAX + 200) }]);
assert.strictEqual(bavard[0].text.length, CONTEXT_TEXT_MAX);

// Entrées mal formées : écartées une par une. Un contexte partiel reste
// utile ; un signalement refusé pour une virgule ne l'est pas.
const mixte = normalizeContext([
  null,
  'pas un objet',
  { senderID: 5 },                       // sans texte
  { senderID: 5, text: '   ' },          // texte vide
  { text: 'sans expéditeur' },           // recevable, senderID à null
  unMessage(9),
]);
assert.strictEqual(mixte.length, 2);
assert.strictEqual(mixte[0].senderID, null, 'un expéditeur absent devient null, pas 0');
assert.strictEqual(mixte[0].sendAt, null);
assert.strictEqual(mixte[1].text, 'm9');

// Un expéditeur invalide ne doit pas devenir un identifiant plausible : null
// dit « on ne sait pas », 0 ou NaN désigneraient un compte.
assert.strictEqual(normalizeContext([{ senderID: 0, text: 'a' }])[0].senderID, null);
assert.strictEqual(normalizeContext([{ senderID: -3, text: 'a' }])[0].senderID, null);
assert.strictEqual(normalizeContext([{ senderID: 'abc', text: 'a' }])[0].senderID, null);
assert.strictEqual(normalizeContext([{ senderID: '12', text: 'a' }])[0].senderID, 12);

// Rien d'exploitable : `null` et non une liste vide. Une liste vide
// s'écrirait en JSON dans la colonne et la console afficherait un bloc de
// contexte sans contexte.
assert.strictEqual(normalizeContext([]), null);
assert.strictEqual(normalizeContext(null), null);
assert.strictEqual(normalizeContext('non'), null);
assert.strictEqual(normalizeContext([null, { text: '' }]), null);

// Une date trop longue est coupée, pas rejetée : elle n'est affichée que
// pour situer le message, et une borne évite qu'elle serve de champ libre.
assert.strictEqual(
  normalizeContext([{ senderID: 5, sendAt: 'z'.repeat(200), text: 'a' }])[0].sendAt.length,
  40,
);

console.log('reportExcerpt.test.js OK');
