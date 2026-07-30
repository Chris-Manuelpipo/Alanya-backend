const assert = require('assert');
const qrContactTokens = require('./qrContactTokens');

// Création : jeton non vide, TTL de 10 minutes, propriétaire porté.
const a = qrContactTokens.create(42);
assert.ok(a && a.token, 'jeton non vide');
assert.strictEqual(a.alanyaID, 42);
assert.strictEqual(a.expiresAt - a.createdAt, qrContactTokens.TTL_MS);
assert.strictEqual(qrContactTokens.TTL_MS, 10 * 60 * 1000, 'TTL de 10 minutes');

// Lecture sans consommation : get() laisse le jeton en place.
assert.strictEqual(qrContactTokens.get(a.token).token, a.token);
assert.strictEqual(qrContactTokens.get(a.token).token, a.token, 'get non destructif');

// Un seul jeton actif par utilisateur : en créer un nouveau tue le précédent.
const b = qrContactTokens.create(42);
assert.notStrictEqual(b.token, a.token, 'jeton renouvelé');
assert.strictEqual(qrContactTokens.get(a.token), null, 'ancien jeton invalidé');
assert.strictEqual(qrContactTokens.get(b.token).token, b.token);

// Deux utilisateurs ne se marchent pas dessus.
const autre = qrContactTokens.create(7);
assert.strictEqual(qrContactTokens.get(b.token).token, b.token, 'jeton de 42 intact');
assert.strictEqual(qrContactTokens.get(autre.token).alanyaID, 7);

// Consommation : usage unique — la première lecture consommante supprime.
const consomme = qrContactTokens.consume(b.token);
assert.strictEqual(consomme.alanyaID, 42);
assert.strictEqual(qrContactTokens.get(b.token), null, 'jeton consommé disparu');
assert.strictEqual(qrContactTokens.consume(b.token), null, 'double consommation refusée');

// Expiration paresseuse : on vieillit l'entrée à la main plutôt que d'attendre.
const perime = qrContactTokens.create(42);
qrContactTokens.get(perime.token).expiresAt = Date.now() - 1;
assert.strictEqual(qrContactTokens.get(perime.token), null, 'jeton expiré');
assert.strictEqual(qrContactTokens.consume(perime.token), null, 'consommation d\'un expiré refusée');

// Après expiration, l'utilisateur peut regénérer normalement.
const neuf = qrContactTokens.create(42);
assert.ok(qrContactTokens.get(neuf.token), 'régénération après expiration');
qrContactTokens.clear(neuf.token);
assert.strictEqual(qrContactTokens.get(neuf.token), null, 'clear supprime');
qrContactTokens.clear(autre.token);

console.log('qrContactTokens.test.js OK');
