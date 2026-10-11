/**
 * Normalisation du `type` d'un message — `node src/utils/messageType.test.js`.
 *
 * Pur, sans base : l'équivalent « qui échoue avant, passe après » de la faille
 * ÉLEVÉE de l'audit sécurité — un `10.4` (ou `"9.5"`, `"10abc"`) arrivait à
 * MySQL, qui ARRONDIT à 10 à l'INSERT : type 10 écrit sans résolution serveur.
 */
const assert = require('assert');
const { normalizeMessageType, TYPE_MAX } = require('./messageType');

let ok = 0;
const test = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

test('entiers (nombre) acceptés, 0 par défaut', () => {
  assert.strictEqual(normalizeMessageType(0), 0);
  assert.strictEqual(normalizeMessageType(10), 10);
  assert.strictEqual(normalizeMessageType(TYPE_MAX), TYPE_MAX);
  assert.strictEqual(normalizeMessageType(undefined), 0);
  assert.strictEqual(normalizeMessageType(null), 0);
  assert.strictEqual(normalizeMessageType(''), 0);
});

test('chaîne strictement décimale entière acceptée', () => {
  assert.strictEqual(normalizeMessageType('10'), 10);
  assert.strictEqual(normalizeMessageType(' 10 '), 10);
  assert.strictEqual(normalizeMessageType('0'), 0);
  assert.strictEqual(normalizeMessageType('255'), 255);
});

test('fractions refusées — LE cas de la faille', () => {
  // Nombre décimal : MySQL l'arrondit à 10 sans que personne n'ait résolu le sticker.
  assert.strictEqual(normalizeMessageType(10.4), null);
  assert.strictEqual(normalizeMessageType('10.4'), null);
  assert.strictEqual(normalizeMessageType('9.5'), null);
  assert.strictEqual(normalizeMessageType(9.9), null);
  assert.strictEqual(normalizeMessageType(-0.1), null);
});

test('tout le reste est refusé', () => {
  assert.strictEqual(normalizeMessageType('10abc'), null);
  assert.strictEqual(normalizeMessageType('1e2'), null);
  assert.strictEqual(normalizeMessageType('0x10'), null);
  assert.strictEqual(normalizeMessageType('10,0'), null);
  assert.strictEqual(normalizeMessageType('dix'), null);
  assert.strictEqual(normalizeMessageType(true), null);
  assert.strictEqual(normalizeMessageType({}), null);
  assert.strictEqual(normalizeMessageType([10]), null);
  assert.strictEqual(normalizeMessageType(Infinity), null);
  assert.strictEqual(normalizeMessageType(NaN), null);
});

test('bornes : 0 inclus, 255 inclus, 256 et -1 exclus', () => {
  assert.strictEqual(normalizeMessageType(256), null);
  assert.strictEqual(normalizeMessageType(-1), null);
  assert.strictEqual(normalizeMessageType('256'), null);
  assert.strictEqual(normalizeMessageType('-1'), null);
});

console.log(`messageType.test.js : ${ok} tests OK`);