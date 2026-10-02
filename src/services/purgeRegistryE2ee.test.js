/**
 * `node src/services/purgeRegistryE2ee.test.js`
 *
 * La purge des enveloppes supprime définitivement des lignes, et la seule
 * règle qui compte ici ne se voit pas en la lisant :
 *
 *   **elle ne doit JAMAIS toucher `message_e2ee`.**
 *
 * Une enveloppe remise ne sert plus à rien — le destinataire a déchiffré et
 * rangé le clair chez lui. Le CORPS, lui, est la ligne du message. Le
 * supprimer viderait des messages que plusieurs chemins de lecture
 * (historique, delta, aperçus, accusés) relisent, et le vide ne se verrait
 * qu'au moment où quelqu'un remonte dans un vieux fil — bien après la nuit où
 * la purge est passée.
 *
 * Le test lit le SQL du descripteur plutôt que d'exécuter la purge : même
 * méthode que `errorCodeCoverage`, et pour la même raison — il n'a besoin ni
 * de base ni de données, donc il tourne vraiment.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, 'purgeRegistry.js'), 'utf8',
);

// Le descripteur, du nom de la purge à la fin de son bloc.
const debut = SOURCE.indexOf('  e2ee_envelope: {');
assert.ok(debut > 0, 'la purge e2ee_envelope doit être déclarée dans le registre');
const fin = SOURCE.indexOf('\n  data_retention: {', debut);
assert.ok(fin > debut, 'le bloc e2ee_envelope doit précéder data_retention');
const bloc = SOURCE.slice(debut, fin);

// ── L'invariant ──────────────────────────────────────────────────────────

assert.ok(
  !/DELETE\s+FROM\s+message_e2ee/i.test(bloc),
  'la purge ne doit JAMAIS supprimer de `message_e2ee` : le corps est la '
  + 'ligne du message, pas une enveloppe périmée',
);
assert.ok(
  !/DELETE\s+FROM\s+message\b/i.test(bloc),
  'la purge ne doit toucher ni `message` ni `message_e2ee`',
);
assert.ok(
  !/DELETE\s+FROM\s+e2ee_device_keys/i.test(bloc),
  'les bundles d\'identité ne se purgent pas : un appareil sans bundle ne '
  + 'reçoit plus rien, et personne ne saurait pourquoi',
);

// Ce qu'elle supprime, et rien d'autre.
const tablesSupprimees = [...bloc.matchAll(/DELETE\s+FROM\s+(\w+)/gi)]
  .map((m) => m[1]).sort();
assert.deepStrictEqual(
  [...new Set(tablesSupprimees)],
  ['e2ee_one_time_prekeys', 'message_envelope'],
  'deux cibles exactement : les enveloppes et les clés à usage unique servies',
);

// ── Les deux âges, et leurs bornes ───────────────────────────────────────

// Une enveloppe remise n'est pas supprimée le jour même : un appareil peut
// réinstaller juste après avoir reçu, avant d'avoir sauvegardé, et ces
// quelques jours sont sa seule fenêtre de rattrapage par la synchronisation.
assert.ok(
  /delivered_at IS NOT NULL/.test(bloc) && /delivered_at IS NULL/.test(bloc),
  'les deux cas — remise et jamais remise — doivent être traités séparément, '
  + 'avec des âges différents',
);
assert.ok(
  /min: 1,/.test(bloc),
  'le délai des enveloppes remises ne doit pas pouvoir descendre à 0 jour',
);

// Une clé à usage unique servie garde son `key_id` sous l'index UNIQUE : c'est
// ce qui empêche un appareil de republier un identifiant déjà consommé. Seules
// les clés CONSOMMÉES partent ; purger les clés libres viderait le stock.
assert.ok(
  /claimed_at IS NOT NULL/.test(bloc),
  'seules les clés à usage unique DÉJÀ SERVIES sont purgées : supprimer les '
  + 'clés libres viderait le stock et dégraderait tous les amorçages suivants',
);

// ── Le registre l'expose à l'administration ──────────────────────────────

const { NAMES } = (() => {
  // `require` du module complet ouvrirait le pool MySQL ; on relit la
  // constante dans la source, comme le reste de ce fichier.
  const m = SOURCE.match(/const NAMES = \[([^\]]+)\]/);
  assert.ok(m, 'NAMES doit rester une liste littérale');
  return { NAMES: m[1].split(',').map((x) => x.trim().replace(/'/g, '')) };
})();
assert.ok(
  NAMES.includes('e2ee_envelope'),
  'sans son nom dans NAMES, la purge n\'apparaît pas dans l\'espace '
  + 'super-admin : ni interrupteur, ni compteur, ni trace de passage — '
  + 'exactement le défaut que le registre a été créé pour corriger',
);

console.log('purgeRegistryE2ee.test.js OK');
