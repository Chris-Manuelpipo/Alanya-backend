const assert = require('assert');
const qrLoginSessions = require('./qrLoginSessions');

const newSession = () =>
  qrLoginSessions.create({
    deviceId: 'hw-1',
    deviceName: 'Pixel 8',
    platform: 'android',
    ipAddress: '10.0.0.1',
  });

// Création : statut initial, secrets présents et tous distincts.
const created = newSession();
assert.strictEqual(created.status, 'pending');
assert.strictEqual(created.result, null);
assert.strictEqual(created.deviceName, 'Pixel 8');
assert.ok(created.sessionId && created.scanSecret && created.pollToken, 'secrets non vides');
assert.notStrictEqual(created.scanSecret, created.pollToken, 'scanSecret != pollToken');
assert.notStrictEqual(created.sessionId, created.scanSecret, 'sessionId != scanSecret');
assert.notStrictEqual(created.sessionId, created.pollToken, 'sessionId != pollToken');
assert.strictEqual(created.expiresAt - created.createdAt, qrLoginSessions.TTL_MS);

// Deux sessions ne partagent aucun secret.
const other = newSession();
assert.notStrictEqual(other.sessionId, created.sessionId, 'sessionId unique');
assert.notStrictEqual(other.scanSecret, created.scanSecret, 'scanSecret unique');
qrLoginSessions.clear(other.sessionId);

// markScanned : pending -> scanned, idempotent.
let entry = qrLoginSessions.markScanned(created.sessionId, 42);
assert.ok(entry);
assert.strictEqual(entry.status, 'scanned');
assert.strictEqual(entry.scannedByAlanyaID, 42);
entry = qrLoginSessions.markScanned(created.sessionId, 42);
assert.strictEqual(entry.status, 'scanned', 'markScanned idempotent');
assert.strictEqual(qrLoginSessions.markScanned('inconnu', 42), null, 'session inconnue');

// approve exige une réservation préalable : sans beginApproval, refus.
const result = { user: { alanyaID: 42 }, accessToken: 'acc', refreshToken: 'ref' };
assert.strictEqual(
  qrLoginSessions.approve(created.sessionId, { result }), null,
  'approve sans beginApproval refusé',
);

// beginApproval : réserve, puis approve livre le résultat.
entry = qrLoginSessions.beginApproval(created.sessionId);
assert.ok(entry, 'réservation acceptée depuis scanned');
assert.strictEqual(entry.status, 'approving');
assert.strictEqual(
  qrLoginSessions.beginApproval(created.sessionId), null,
  'double réservation refusée — deux confirmations simultanées',
);
entry = qrLoginSessions.approve(created.sessionId, { scannedByAlanyaID: 42, result });
assert.strictEqual(entry.status, 'approved');
const readBack = qrLoginSessions.get(created.sessionId);
assert.strictEqual(readBack.status, 'approved');
assert.strictEqual(readBack.result.accessToken, 'acc');
assert.strictEqual(readBack.result.user.alanyaID, 42);

// Une session approuvée ne régresse pas à 'scanned'.
entry = qrLoginSessions.markScanned(created.sessionId, 42);
assert.strictEqual(entry.status, 'approved', 'approved non régressé par un rescan');

// clear : livraison à usage unique des tokens.
qrLoginSessions.clear(created.sessionId);
assert.strictEqual(qrLoginSessions.get(created.sessionId), null, 'clear supprime la session');

// deny : passe en denied et n'expose aucun résultat.
const denied = newSession();
entry = qrLoginSessions.deny(denied.sessionId);
assert.strictEqual(entry.status, 'denied');
assert.strictEqual(entry.result, null);
assert.strictEqual(qrLoginSessions.get(denied.sessionId).status, 'denied');
assert.strictEqual(qrLoginSessions.deny('inconnu'), null);
qrLoginSessions.clear(denied.sessionId);

// Expiration paresseuse : on vieillit l'entrée à la main plutôt que d'attendre.
const stale = newSession();
qrLoginSessions.get(stale.sessionId).expiresAt = Date.now() - 1;
assert.strictEqual(qrLoginSessions.get(stale.sessionId), null, 'session expirée');
assert.strictEqual(qrLoginSessions.markScanned(stale.sessionId, 42), null, 'markScanned expiré');
assert.strictEqual(qrLoginSessions.beginApproval(stale.sessionId), null, 'beginApproval expiré');
assert.strictEqual(qrLoginSessions.approve(stale.sessionId, { result }), null, 'approve expiré');

// Expiration PENDANT l'approbation : le contrôleur réserve, part en base, et la
// session meurt entre-temps. approve() doit refuser, sinon on annoncerait une
// approbation dont personne ne viendra chercher les tokens.
const enVol = newSession();
assert.ok(qrLoginSessions.beginApproval(enVol.sessionId));
qrLoginSessions.get(enVol.sessionId).expiresAt = Date.now() - 1;
assert.strictEqual(
  qrLoginSessions.approve(enVol.sessionId, { result }), null,
  'approve refusé si la session a expiré pendant les await',
);

// abortApproval : rend la session à son statut d'avant en cas d'échec.
const annulee = newSession();
qrLoginSessions.markScanned(annulee.sessionId, 7);
qrLoginSessions.beginApproval(annulee.sessionId);
entry = qrLoginSessions.abortApproval(annulee.sessionId);
assert.strictEqual(entry.status, 'scanned', 'abortApproval restaure le statut');
assert.ok(qrLoginSessions.beginApproval(annulee.sessionId), 'réservable à nouveau après abandon');
qrLoginSessions.clear(annulee.sessionId);

// Une session approuvée puis expirée ne livre plus rien.
const late = newSession();
qrLoginSessions.beginApproval(late.sessionId);
qrLoginSessions.approve(late.sessionId, { scannedByAlanyaID: 42, result });
qrLoginSessions.get(late.sessionId).expiresAt = Date.now() - 1;
assert.strictEqual(qrLoginSessions.get(late.sessionId), null, 'approuvée mais expirée');

console.log('qrLoginSessions.test.js OK');
