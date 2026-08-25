// Jetons d'ajout de contact par QR — usage unique et réservation.
//
// Le store est async depuis la migration Redis : ces tests exercent le repli
// mémoire (aucun REDIS_URL ici). La vraie concurrence se vérifie contre un
// Redis réel dans qrContactTokens.race.test.js.
const assert = require('assert');
const qrContactTokens = require('./qrContactTokens');

(async () => {
  const a = await qrContactTokens.create(42);
  assert.ok(a.token, 'jeton non vide');
  assert.strictEqual(a.alanyaID, 42);
  assert.strictEqual(a.expiresAt - a.createdAt, qrContactTokens.TTL_MS);
  assert.strictEqual(qrContactTokens.TTL_MS, 10 * 60 * 1000, 'dix minutes annoncées');

  // Lecture non destructive : afficher la page publique d'un code ne le consomme pas.
  assert.strictEqual((await qrContactTokens.get(a.token)).token, a.token);
  assert.strictEqual((await qrContactTokens.get(a.token)).token, a.token, 'get non destructif');

  // Un seul code vivant par utilisateur : en générer un invalide le précédent.
  const b = await qrContactTokens.create(42);
  assert.notStrictEqual(b.token, a.token);
  assert.strictEqual(await qrContactTokens.get(a.token), null, 'ancien jeton invalidé');
  assert.strictEqual((await qrContactTokens.get(b.token)).token, b.token);

  // Les utilisateurs ne se marchent pas dessus.
  const autre = await qrContactTokens.create(7);
  assert.strictEqual((await qrContactTokens.get(b.token)).token, b.token, 'jeton de 42 intact');
  assert.strictEqual((await qrContactTokens.get(autre.token)).alanyaID, 7);

  // claim réserve le jeton : un second scan ne peut plus l'emporter, y compris
  // pendant que l'ajout du contact est en cours côté base.
  const reserve = await qrContactTokens.claim(b.token);
  assert.ok(reserve, 'première réservation acceptée');
  assert.strictEqual(reserve.alanyaID, 42);
  assert.strictEqual(
    await qrContactTokens.claim(b.token), null,
    'seconde réservation refusée — le contrat dit « une seule personne »',
  );
  assert.strictEqual(
    await qrContactTokens.get(b.token), null,
    'un jeton réservé n\'est plus présenté comme disponible',
  );

  // release : l'ajout a échoué, le code redevient utilisable. Un scan raté ne
  // doit pas tuer le code de son détenteur.
  await qrContactTokens.release(b.token);
  assert.ok(await qrContactTokens.get(b.token), 'code rendu après échec');
  assert.ok(await qrContactTokens.claim(b.token), 'réservable à nouveau');

  // commit : l'ajout a réussi, le jeton disparaît définitivement.
  await qrContactTokens.commit(b.token);
  assert.strictEqual(await qrContactTokens.get(b.token), null, 'jeton consommé disparu');
  assert.strictEqual(await qrContactTokens.claim(b.token), null, 'double consommation refusée');

  // Expiration paresseuse.
  const perime = await qrContactTokens.create(42);
  (await qrContactTokens.get(perime.token)).expiresAt = Date.now() - 1;
  assert.strictEqual(await qrContactTokens.get(perime.token), null, 'jeton expiré');
  assert.strictEqual(await qrContactTokens.claim(perime.token), null, 'réservation d\'un expiré refusée');

  // Régénération après expiration.
  const neuf = await qrContactTokens.create(42);
  assert.ok(await qrContactTokens.get(neuf.token), 'régénération après expiration');
  await qrContactTokens.clear(neuf.token);
  assert.strictEqual(await qrContactTokens.get(neuf.token), null, 'clear supprime');
  await qrContactTokens.clear(autre.token);

  console.log('qrContactTokens.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
