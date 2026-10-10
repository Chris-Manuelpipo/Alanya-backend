/**
 * `node src/services/purgeSchedule.test.js`
 *
 * Toute purge déclarée dans le registre doit être planifiée dans le balayage
 * de `server.js`. Sinon l'interrupteur de l'admin affiche « active » pour une
 * purge qui ne tourne qu'à la main : c'est arrivé deux fois, à
 * `backup_key_access` puis à `e2ee_envelope`.
 *
 * Le test lit la source plutôt que de démarrer le serveur, comme
 * `purgeRegistryE2ee.test.js` : ni base ni Redis nécessaires.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { NAMES } = require('./purgeRegistry');

const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

const debut = SERVER.indexOf('const balayageRetention = () => {');
assert.ok(debut > 0, 'le balayage de rétention doit exister dans server.js');
const fin = SERVER.indexOf('\n    };', debut);
const balayage = SERVER.slice(debut, fin);

// Couples [bail, purge] de la liste, commentaires exclus.
const planifiees = [...balayage.matchAll(/\[\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*\]/g)]
  .map((m) => ({ bail: m[1], purge: m[2] }));

for (const name of NAMES) {
  assert.ok(
    planifiees.some((p) => p.purge === name),
    `la purge « ${name} » est déclarée dans le registre mais jamais planifiée dans server.js`,
  );
}
for (const { purge } of planifiees) {
  assert.ok(NAMES.includes(purge), `purge planifiée inconnue du registre : ${purge}`);
}

// Un bail par purge : deux purges sous le même bail s'excluraient l'une l'autre.
const baux = planifiees.map((p) => p.bail);
assert.strictEqual(new Set(baux).size, baux.length, 'chaque purge doit avoir son propre bail');

console.log('purgeSchedule.test.js ✓');
