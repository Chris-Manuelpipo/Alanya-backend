const assert = require('assert');
const {
  ALPHABET,
  CODE_LENGTH,
  checkSymbol,
  generateCode,
  formatCode,
  parseCode,
  hashCode,
  hintOf,
  attemptAfterFailure,
  lockRemainingSeconds,
} = require('./codeFormat');

// ── Génération ─────────────────────────────────────────────────────────────
{
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = generateCode();
    assert.strictEqual(code.length, CODE_LENGTH);
    assert.ok([...code].every((c) => ALPHABET.includes(c)), `symboles valides : ${code}`);
    assert.ok(!/[ILOU]/.test(code), 'jamais de I, L, O ni U');
    assert.strictEqual(checkSymbol(code.slice(0, -1)), code.slice(-1), 'le contrôle est cohérent');
    assert.deepStrictEqual(parseCode(code), { ok: true, canonical: code });
    seen.add(code);
  }
  assert.strictEqual(seen.size, 2000, 'aucun doublon sur 2000 tirages');
}

// ── Affichage et saisie ────────────────────────────────────────────────────
{
  const code = generateCode();
  const shown = formatCode(code);
  assert.ok(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(shown), shown);
  // Toutes les écritures qu'un utilisateur peut taper redonnent le même code.
  assert.strictEqual(parseCode(shown).canonical, code);
  assert.strictEqual(parseCode(shown.toLowerCase()).canonical, code, 'minuscules');
  assert.strictEqual(parseCode(`  ${shown.replace(/-/g, ' ')}  `).canonical, code, 'espaces');
  assert.strictEqual(parseCode(shown.replace(/-/g, '')).canonical, code, 'sans tirets');
  assert.strictEqual(parseCode(shown.replace(/-/g, '.')).canonical, code, 'points');
}
{
  // Confusions usuelles : O lu comme 0, I et L lus comme 1.
  const base = '0123456789ABCD';
  const code = base + checkSymbol(base);
  assert.strictEqual(parseCode(code.replace('0', 'O')).canonical, code, 'O pour 0');
  assert.strictEqual(parseCode(code.replace('1', 'l')).canonical, code, 'l pour 1');
  assert.strictEqual(parseCode(code.replace('1', 'I')).canonical, code, 'I pour 1');
}

// ── Refus ──────────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(parseCode(''), { ok: false, reason: 'format' });
  assert.deepStrictEqual(parseCode(null), { ok: false, reason: 'format' });
  assert.deepStrictEqual(parseCode('ABC'), { ok: false, reason: 'format' }, 'trop court');
  assert.deepStrictEqual(parseCode('A'.repeat(16)), { ok: false, reason: 'format' }, 'trop long');
  const code = generateCode();
  assert.deepStrictEqual(parseCode(`${code.slice(0, 5)}U${code.slice(6)}`), { ok: false, reason: 'format' }, 'U exclu');
  assert.deepStrictEqual(parseCode(`${code.slice(0, 5)}#${code.slice(6)}`), { ok: false, reason: 'format' });
}
{
  // Une substitution d'UN symbole, n'importe où, est toujours détectée —
  // y compris 0 contre Z, les deux valeurs extrêmes. Vérifié sur 60 codes.
  for (let n = 0; n < 60; n++) {
    const code = generateCode();
    for (let i = 0; i < CODE_LENGTH; i++) {
      for (const other of ALPHABET) {
        if (other === code[i]) continue;
        const typo = code.slice(0, i) + other + code.slice(i + 1);
        const parsed = parseCode(typo);
        assert.strictEqual(parsed.ok, false, `faute en ${i} (${code[i]}→${other}) sur ${code}`);
        assert.strictEqual(parsed.reason, 'checksum');
      }
    }
  }
}
{
  // Deux symboles voisins inversés : détecté, sauf quand leurs valeurs diffèrent
  // de 16 (cas connu, voir codeFormat.js). Code fixe, sans paire de ce genre.
  const base = '0123456789ABCD';
  const code = base + checkSymbol(base);
  assert.deepStrictEqual(parseCode(code), { ok: true, canonical: code });
  for (let i = 0; i < CODE_LENGTH - 1; i++) {
    if (code[i] === code[i + 1]) continue;
    if (Math.abs(ALPHABET.indexOf(code[i]) - ALPHABET.indexOf(code[i + 1])) === 16) continue;
    const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
    assert.strictEqual(parseCode(swapped).ok, false, `inversion en ${i} détectée`);
  }
}

// ── Empreinte ──────────────────────────────────────────────────────────────
{
  const code = generateCode();
  const a = hashCode(code, 'secret-a'.repeat(4));
  assert.ok(/^[0-9a-f]{64}$/.test(a));
  assert.strictEqual(a, hashCode(code, 'secret-a'.repeat(4)), 'déterministe');
  assert.notStrictEqual(a, hashCode(code, 'secret-b'.repeat(4)), 'dépend du secret');
  assert.notStrictEqual(a, hashCode(generateCode(), 'secret-a'.repeat(4)), 'dépend du code');
  assert.strictEqual(hintOf(code), code.slice(-4));
  assert.strictEqual(hintOf(code).length, 4);
}

// ── Tentatives ─────────────────────────────────────────────────────────────
{
  const T0 = new Date('2026-10-03T10:00:00Z');
  const min = (n) => new Date(T0.getTime() + n * 60_000);

  let state = attemptAfterFailure(null, T0);
  assert.strictEqual(state.failures, 1);
  assert.strictEqual(state.lockedUntil, null);

  // Quatre échecs : pas encore de verrou ; le cinquième verrouille quinze minutes.
  const row = (s) => ({ failures: s.failures, window_start: s.windowStart, locked_until: s.lockedUntil });
  for (let i = 2; i <= 4; i++) {
    state = attemptAfterFailure(row(state), min(i));
    assert.strictEqual(state.failures, i);
    assert.strictEqual(state.lockedUntil, null);
  }
  state = attemptAfterFailure(row(state), min(5));
  assert.strictEqual(state.failures, 5);
  assert.strictEqual(state.lockedUntil.toISOString(), min(20).toISOString());
  assert.strictEqual(lockRemainingSeconds(state.lockedUntil, min(5)), 15 * 60);
  assert.strictEqual(lockRemainingSeconds(state.lockedUntil, min(19)), 60);
  assert.strictEqual(lockRemainingSeconds(state.lockedUntil, min(20)), 0, 'le verrou tombe à l\'instant dit');
  assert.strictEqual(lockRemainingSeconds(null, T0), 0);

  // Passé la fenêtre de quinze minutes, on repart de un.
  const stale = attemptAfterFailure({ failures: 4, window_start: T0, locked_until: null }, min(16));
  assert.strictEqual(stale.failures, 1);
  assert.strictEqual(stale.windowStart.toISOString(), min(16).toISOString());
  // Un échec isolé à la limite de la fenêtre compte encore dans la même série.
  const edge = attemptAfterFailure({ failures: 4, window_start: T0, locked_until: null }, min(15));
  assert.strictEqual(edge.failures, 5);
  assert.ok(edge.lockedUntil);
}

console.log('codeFormat.test.js OK');
