// Qui sonne encore pour cet appel ?
//
// `end_group_call` ne prévenait que la salle socket — or un invité dont
// l'application est fermée n'y est jamais entré : il n'a été joint que par
// push. Rien ne retirait son entrée CallKit, et son téléphone sonnait les
// quarante secondes complètes pour un appel que tout le monde avait quitté.
// Cette liste est ce qui manquait pour le prévenir.
const assert = require('assert');
const ownership = require('./callDeviceOwnership');

const SALON = 'group_12_1712345678901';

(async () => {
  assert.deepStrictEqual(
    await ownership.listUsers(SALON),
    [],
    'une clé inconnue ne désigne personne',
  );

  await ownership.ring(SALON, 7);
  await ownership.ring(SALON, 9);

  const sonnent = (await ownership.listUsers(SALON, 'ringing')).sort();
  assert.deepStrictEqual(sonnent, [7, 9], 'les deux invités sonnent');

  // Un invité décroche : il ne sonne plus, mais il est toujours suivi.
  await ownership.tryClaim(SALON, 7, 'appareil-A', 'socket-1');
  assert.deepStrictEqual(
    await ownership.listUsers(SALON, 'ringing'),
    [9],
    'seul celui qui n\'a pas décroché sonne encore',
  );
  assert.deepStrictEqual(
    (await ownership.listUsers(SALON)).sort(),
    [7, 9],
    'sans filtre, les deux sont suivis',
  );

  await ownership.release(SALON);
  assert.deepStrictEqual(
    await ownership.listUsers(SALON),
    [],
    'la salle libérée ne suit plus personne',
  );

  console.log('callDeviceOwnershipList.test.js OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
