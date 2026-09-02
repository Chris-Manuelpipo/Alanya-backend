// Le repli « dernier appel entre ces deux comptes » ne doit pas s'appliquer
// quand le refus désigne autre chose qu'un appel à deux.
//
// Une invitation de groupe refusée porte un `roomId` de la forme
// `group_<conv>_<ms>`. Le repli sélectionnait alors le dernier appel à deux
// entre l'invitant et l'invité et le passait à « Rejeté », chez les DEUX.
const assert = require('assert');
const { canFallBackToLastCall } = require('./rejectFallback');

// ── Le cas pour lequel le repli a été écrit ────────────────────────────────
assert.strictEqual(canFallBackToLastCall(null), true, 'client sans indice');
assert.strictEqual(canFallBackToLastCall(undefined), true);
assert.strictEqual(canFallBackToLastCall(''), true);
assert.strictEqual(canFallBackToLastCall('   '), true);

// ── Un identifiant d'appel désigne un appel : le repli est légitime ────────
assert.strictEqual(canFallBackToLastCall('4213'), true);
assert.strictEqual(canFallBackToLastCall(4213), true);
assert.strictEqual(canFallBackToLastCall(' 4213 '), true);

// ── Un salon de groupe n'est pas un appel à deux ───────────────────────────
assert.strictEqual(
  canFallBackToLastCall('group_12_1712345678901'),
  false,
  'c\'est ce cas qui réécrivait un ancien appel abouti en « Rejeté »',
);

// ── Une session de conférence non plus ─────────────────────────────────────
assert.strictEqual(canFallBackToLastCall('conf_88'), false);

// ── Tout ce qui n'est pas entièrement numérique est refusé ─────────────────
assert.strictEqual(
  canFallBackToLastCall('12abc'),
  false,
  '`toInt` en tirerait 12 ; on exige des chiffres et rien d\'autre',
);
assert.strictEqual(canFallBackToLastCall('meeting_7'), false);
assert.strictEqual(canFallBackToLastCall('-5'), false);

console.log('rejectFallback.test.js OK');
