const assert = require('assert');
const {
  normalizeTarget,
  normalizeReason,
  normalizeNote,
  NOTE_MAX,
} = require('./reportService');

/* ── La cible ────────────────────────────────────────────────────────── */
// L'invariant « exactement une cible » ne peut pas vivre en contrainte CHECK
// (MySQL 3823, cf. migration 073) : il est tenu ici, et nulle part ailleurs.
{
  const t = normalizeTarget({ targetType: 'message', targetId: '42' });
  assert.strictEqual(t.targetType, 'message');
  assert.strictEqual(t.msgId, 42);
  assert.strictEqual(t.userId, null, 'un signalement de message ne vise pas un compte');
}
{
  const t = normalizeTarget({ targetType: 'user', targetId: 7 });
  assert.strictEqual(t.userId, 7);
  assert.strictEqual(t.msgId, null);
}

assert.throws(() => normalizeTarget({ targetType: 'group', targetId: 1 }), /Cible/);
assert.throws(() => normalizeTarget({ targetType: 'user' }), /Identifiant/);
assert.throws(() => normalizeTarget({ targetType: 'user', targetId: 0 }), /Identifiant/);
assert.throws(() => normalizeTarget({ targetType: 'user', targetId: -3 }), /Identifiant/);
// Un identifiant fractionnaire atteindrait la base sous une forme inattendue.
assert.throws(() => normalizeTarget({ targetType: 'message', targetId: 1.5 }), /Identifiant/);

/* ── Le motif ────────────────────────────────────────────────────────── */
assert.strictEqual(normalizeReason('HARASSMENT'), 'harassment');
assert.strictEqual(normalizeReason('  spam  '), 'spam');
assert.throws(() => normalizeReason('parce que'), /Motif/);
assert.throws(() => normalizeReason(''), /Motif/);

/* ── La précision libre ──────────────────────────────────────────────── */
assert.strictEqual(normalizeNote('   '), null, 'une note blanche n’est pas une note');
assert.strictEqual(normalizeNote(null), null);
// Tronquer et non refuser : personne ne doit perdre sa plainte pour l'avoir
// trouvée trop longue à écrire.
assert.strictEqual(normalizeNote('x'.repeat(NOTE_MAX + 50)).length, NOTE_MAX);

console.log('reportService.test.js OK');
