// Sessions de connexion par QR — machine à états et gardes de concurrence.
//
// Le store est async depuis la migration Redis : ces tests exercent le repli
// mémoire (aucun REDIS_URL ici). L'atomicité réelle des transitions se vérifie
// contre un vrai Redis dans qrLoginSessions.race.test.js — un repli mémoire
// est atomique par construction, il ne prouverait rien.
const assert = require('assert');
const qrLoginSessions = require('./qrLoginSessions');

const newSession = () =>
  qrLoginSessions.create({
    deviceId: 'hw-1',
    deviceName: 'Pixel 8',
    platform: 'android',
    ipAddress: '10.0.0.1',
  });

(async () => {
  // Création : statut initial, secrets présents et tous distincts.
  const created = await newSession();
  assert.strictEqual(created.status, 'pending');
  assert.strictEqual(created.result, null);
  assert.strictEqual(created.deviceName, 'Pixel 8');
  assert.ok(created.sessionId && created.scanSecret && created.pollToken, 'secrets non vides');
  assert.notStrictEqual(created.scanSecret, created.pollToken, 'scanSecret != pollToken');
  assert.notStrictEqual(created.sessionId, created.scanSecret, 'sessionId != scanSecret');
  assert.notStrictEqual(created.sessionId, created.pollToken, 'sessionId != pollToken');
  assert.strictEqual(created.expiresAt - created.createdAt, qrLoginSessions.TTL_MS);

  // Deux sessions ne partagent aucun secret.
  const other = await newSession();
  assert.notStrictEqual(other.sessionId, created.sessionId, 'sessionId unique');
  assert.notStrictEqual(other.scanSecret, created.scanSecret, 'scanSecret unique');
  await qrLoginSessions.clear(other.sessionId);

  // markScanned : pending -> scanned, idempotent.
  let entry = await qrLoginSessions.markScanned(created.sessionId, 42);
  assert.ok(entry);
  assert.strictEqual(entry.status, 'scanned');
  assert.strictEqual(entry.scannedByAlanyaID, 42);
  entry = await qrLoginSessions.markScanned(created.sessionId, 42);
  assert.strictEqual(entry.status, 'scanned', 'markScanned idempotent');
  assert.strictEqual(await qrLoginSessions.markScanned('inconnu', 42), null, 'session inconnue');

  // approve exige une réservation préalable : sans beginApproval, refus.
  const result = { user: { alanyaID: 42 }, accessToken: 'acc', refreshToken: 'ref' };
  assert.strictEqual(
    await qrLoginSessions.approve(created.sessionId, { result }), null,
    'approve sans beginApproval refusé',
  );

  // beginApproval : réserve, puis approve livre le résultat.
  entry = await qrLoginSessions.beginApproval(created.sessionId);
  assert.ok(entry, 'réservation acceptée depuis scanned');
  assert.strictEqual(entry.status, 'approving');
  assert.strictEqual(
    await qrLoginSessions.beginApproval(created.sessionId), null,
    'double réservation refusée — deux confirmations simultanées',
  );
  entry = await qrLoginSessions.approve(created.sessionId, { scannedByAlanyaID: 42, result });
  assert.strictEqual(entry.status, 'approved');
  const readBack = await qrLoginSessions.get(created.sessionId);
  assert.strictEqual(readBack.status, 'approved');
  assert.strictEqual(readBack.result.accessToken, 'acc');
  assert.strictEqual(readBack.result.user.alanyaID, 42);

  // Une session approuvée ne régresse pas à 'scanned'.
  entry = await qrLoginSessions.markScanned(created.sessionId, 42);
  assert.strictEqual(entry.status, 'approved', 'approved non régressé par un rescan');

  // takeApproved : livraison à usage unique. Deux interrogations concurrentes
  // du même statut ne doivent pas emporter les tokens toutes les deux.
  const pris = await qrLoginSessions.takeApproved(created.sessionId);
  assert.ok(pris, 'première livraison acceptée');
  assert.strictEqual(pris.result.accessToken, 'acc');
  assert.strictEqual(pris.status, 'approved', 'statut annoncé au demandeur');
  assert.strictEqual(
    await qrLoginSessions.takeApproved(created.sessionId), null,
    'seconde livraison refusée — les tokens ne partent qu\'une fois',
  );
  assert.strictEqual(await qrLoginSessions.get(created.sessionId), null, 'session effacée après livraison');

  // deny : passe en denied et n'expose aucun résultat.
  const denied = await newSession();
  entry = await qrLoginSessions.deny(denied.sessionId);
  assert.strictEqual(entry.status, 'denied');
  assert.strictEqual(entry.result, null);
  assert.strictEqual((await qrLoginSessions.get(denied.sessionId)).status, 'denied');
  assert.strictEqual(await qrLoginSessions.deny('inconnu'), null);
  await qrLoginSessions.clear(denied.sessionId);

  // deny porte sa propre garde de statut : un refus en vol ne doit pas pouvoir
  // écraser une approbation concurrente et effacer des tokens déjà générés.
  const course = await newSession();
  await qrLoginSessions.beginApproval(course.sessionId);
  await qrLoginSessions.approve(course.sessionId, { scannedByAlanyaID: 9, result });
  assert.strictEqual(
    await qrLoginSessions.deny(course.sessionId), null,
    'deny refusé sur une session déjà approuvée',
  );
  const survivante = await qrLoginSessions.get(course.sessionId);
  assert.strictEqual(survivante.status, 'approved', 'approbation intacte');
  assert.strictEqual(survivante.result.accessToken, 'acc', 'tokens intacts');
  await qrLoginSessions.clear(course.sessionId);

  // setLocation : renseigne le lieu après coup, sans muter un objet rendu.
  const situee = await newSession();
  assert.strictEqual(await qrLoginSessions.setLocation(situee.sessionId, 'Douala, CM'), true);
  assert.strictEqual((await qrLoginSessions.get(situee.sessionId)).location, 'Douala, CM');
  assert.strictEqual(
    await qrLoginSessions.setLocation('inconnu', 'Douala, CM'), false,
    'aucune session ressuscitée par setLocation',
  );
  await qrLoginSessions.clear(situee.sessionId);

  // Expiration paresseuse : on vieillit l'entrée à la main plutôt que d'attendre.
  const stale = await newSession();
  (await qrLoginSessions.get(stale.sessionId)).expiresAt = Date.now() - 1;
  assert.strictEqual(await qrLoginSessions.get(stale.sessionId), null, 'session expirée');
  assert.strictEqual(await qrLoginSessions.markScanned(stale.sessionId, 42), null, 'markScanned expiré');
  assert.strictEqual(await qrLoginSessions.beginApproval(stale.sessionId), null, 'beginApproval expiré');
  assert.strictEqual(await qrLoginSessions.approve(stale.sessionId, { result }), null, 'approve expiré');

  // Expiration PENDANT l'approbation : le contrôleur réserve, part en base, et la
  // session meurt entre-temps. approve() doit refuser, sinon on annoncerait une
  // approbation dont personne ne viendra chercher les tokens.
  const enVol = await newSession();
  assert.ok(await qrLoginSessions.beginApproval(enVol.sessionId));
  (await qrLoginSessions.get(enVol.sessionId)).expiresAt = Date.now() - 1;
  assert.strictEqual(
    await qrLoginSessions.approve(enVol.sessionId, { result }), null,
    'approve refusé si la session a expiré pendant les await',
  );

  // abortApproval : rend la session à son statut d'avant en cas d'échec.
  const annulee = await newSession();
  await qrLoginSessions.markScanned(annulee.sessionId, 7);
  await qrLoginSessions.beginApproval(annulee.sessionId);
  entry = await qrLoginSessions.abortApproval(annulee.sessionId);
  assert.strictEqual(entry.status, 'scanned', 'abortApproval restaure le statut');
  assert.ok(await qrLoginSessions.beginApproval(annulee.sessionId), 'réservable à nouveau après abandon');
  await qrLoginSessions.clear(annulee.sessionId);

  // Une session approuvée puis expirée ne livre plus rien.
  const late = await newSession();
  await qrLoginSessions.beginApproval(late.sessionId);
  await qrLoginSessions.approve(late.sessionId, { scannedByAlanyaID: 42, result });
  (await qrLoginSessions.get(late.sessionId)).expiresAt = Date.now() - 1;
  assert.strictEqual(await qrLoginSessions.get(late.sessionId), null, 'approuvée mais expirée');
  assert.strictEqual(await qrLoginSessions.takeApproved(late.sessionId), null, 'ni livraison');

  console.log('qrLoginSessions.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
