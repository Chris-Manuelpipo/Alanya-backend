/**
 * Contrat FCM/CallKit — invitations conférence / transfert.
 * Vérifie sessionKind, roomId, sessionId, mode sans I/O réseau.
 */
const assert = require('assert');
const { buildIncomingCallPayload } = require('../services/notificationService');

// ── Appel 1-à-1 : pas de champs conférence ───────────────────────────────────
const oneToOne = buildIncomingCallPayload(1, 'Alice', null, false, '42');
assert.strictEqual(oneToOne.type, 'call');
assert.strictEqual(oneToOne.callId, '42');
assert.strictEqual(oneToOne.sessionKind, undefined);
assert.strictEqual(oneToOne.roomId, undefined);
assert.strictEqual(oneToOne.mode, undefined);
assert.strictEqual(oneToOne.sessionId, undefined);

// ── Conférence join ──────────────────────────────────────────────────────────
const sessionId = 'conf_123_1';
const join = buildIncomingCallPayload(1, 'Alice', 'https://x/a.jpg', true, sessionId, {
  roomId: sessionId,
  sessionId,
  sessionKind: 'conference',
  mode: 'join',
});
assert.strictEqual(join.type, 'call');
assert.strictEqual(join.callId, sessionId);
assert.strictEqual(join.roomId, sessionId);
assert.strictEqual(join.sessionId, sessionId);
assert.strictEqual(join.sessionKind, 'conference');
assert.strictEqual(join.mode, 'join');
assert.strictEqual(join.isVideo, 'true');
assert.strictEqual(join.callerId, '1');

// ── Conférence transfer ──────────────────────────────────────────────────────
const transfer = buildIncomingCallPayload(2, 'Bob', null, false, 'conf_99_2', {
  roomId: 'conf_99_2',
  sessionId: 'conf_99_2',
  sessionKind: 'conference',
  mode: 'transfer',
});
assert.strictEqual(transfer.sessionKind, 'conference');
assert.strictEqual(transfer.mode, 'transfer');
assert.strictEqual(transfer.roomId, 'conf_99_2');
assert.strictEqual(transfer.sessionId, 'conf_99_2');
assert.strictEqual(transfer.callId, 'conf_99_2');

// ── Extras vides n'ajoutent rien ─────────────────────────────────────────────
const emptyExtras = buildIncomingCallPayload(1, 'A', null, false, '7', {
  roomId: '',
  sessionKind: '',
  mode: '',
});
assert.strictEqual(emptyExtras.roomId, undefined);
assert.strictEqual(emptyExtras.sessionKind, undefined);

console.log('✅ notificationConferencePayload.test.js — contrat conf OK');
