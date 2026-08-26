const assert = require('assert');
const { ACTIONS, SKIP, reasonFrom } = require('./adminAudit');
const adminRouter = require('../routes/admin');

/* ── Le corps de la requête ne doit jamais entrer dans le journal ─────── */
// `PUT /me/password` transporte un mot de passe en clair : une seule route de
// ce genre suffirait à rendre la table plus dangereuse que ce qu'elle protège.
assert.strictEqual(
  reasonFrom({ currentPassword: 'secret', newPassword: 'aussi-secret' }),
  null,
  'aucun champ non listé ne doit ressortir',
);
assert.strictEqual(reasonFrom({ reason: '  spam répété  ' }), 'spam répété');
assert.strictEqual(reasonFrom({ note: 'vu avec le support' }), 'vu avec le support');
assert.strictEqual(reasonFrom({ reason: '   ' }), null, 'un motif blanc n’est pas un motif');
assert.strictEqual(reasonFrom(null), null);
assert.strictEqual(reasonFrom({ reason: 'x'.repeat(600) }).length, 500);

/* ── Toute route mutante est décrite, ou explicitement écartée ────────── */
// C'est le garde-fou du chantier : une route ajoutée demain sans entrée ici
// fait échouer ce test, au lieu de produire des lignes `unmapped` que
// personne ne regarde.
const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

const routes = [];
for (const layer of adminRouter.stack) {
  if (!layer.route) continue;
  for (const [method, used] of Object.entries(layer.route.methods)) {
    if (used && MUTATING.has(method)) {
      routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
}

assert.ok(routes.length > 20, `pile de routeur inattendue : ${routes.length} routes mutantes`);

const uncovered = routes.filter((key) => !ACTIONS[key] && !SKIP.has(key));
assert.deepStrictEqual(
  uncovered,
  [],
  `route(s) mutante(s) sans entrée dans ACTIONS ni dans SKIP :\n  ${uncovered.join('\n  ')}`,
);

/* ── Et inversement : pas d'entrée fantôme ───────────────────────────── */
// Une entrée qui ne correspond à aucune route est un vestige : elle laisse
// croire que quelque chose est journalisé alors que la route a été renommée.
const known = new Set(routes);
const orphans = [...Object.keys(ACTIONS), ...SKIP.keys()].filter((k) => !known.has(k));
assert.deepStrictEqual(orphans, [], `entrée(s) sans route correspondante :\n  ${orphans.join('\n  ')}`);

console.log(`adminAudit.test.js OK — ${routes.length} routes mutantes couvertes`);
