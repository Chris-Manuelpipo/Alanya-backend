/**
 * Tests de apiError — `node src/utils/apiError.test.js`.
 *
 * L'enjeu tient en une phrase : aucune erreur de driver ne doit franchir la
 * frontière HTTP. Un message MySQL nomme les tables, les colonnes, parfois les
 * valeurs — et l'application l'affichait tel quel avant l'audit de 09/2026.
 */

const assert = require('assert');
const { fail, failInternal, scrubMessage, CODE_INTERNE } = require('./apiError');

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

/** Réponse Express minimale : retient le statut et le corps. */
function fauxRes() {
  return {
    statut: null,
    corps: null,
    status(s) {
      this.statut = s;
      return this;
    },
    json(c) {
      this.corps = c;
      return this;
    },
  };
}

// --- scrubMessage ----------------------------------------------------------

test('scrubMessage laisse passer une phrase présentable', () => {
  assert.strictEqual(scrubMessage('Numéro Alanya requis'), 'Numéro Alanya requis');
});

test('scrubMessage arrête les codes MySQL', () => {
  for (const m of [
    "ER_NO_SUCH_TABLE: Table 'alanya.appareils' doesn't exist",
    'ER_DUP_ENTRY: Duplicate entry',
  ]) {
    assert.strictEqual(scrubMessage(m), 'Erreur interne', `laissé passer : ${m}`);
  }
});

test('scrubMessage arrête les pannes réseau bas niveau', () => {
  assert.strictEqual(scrubMessage('connect ECONNREFUSED 127.0.0.1:3306'), 'Erreur interne');
  assert.strictEqual(scrubMessage('getaddrinfo ENOTFOUND db.interne'), 'Erreur interne');
});

test('scrubMessage arrête une trace de pile', () => {
  const trace = 'TypeError: x is not a function\n    at Object.<anonymous> (/srv/app/a.js:12:5)';
  assert.strictEqual(scrubMessage(trace), 'Erreur interne');
});

test('scrubMessage arrête un chemin absolu du serveur', () => {
  assert.strictEqual(scrubMessage('ENOENT: /var/uploads/photo.jpg'), 'Erreur interne');
});

test('scrubMessage remplace le vide et le non-texte', () => {
  assert.strictEqual(scrubMessage(''), 'Erreur interne');
  assert.strictEqual(scrubMessage('   '), 'Erreur interne');
  assert.strictEqual(scrubMessage(null), 'Erreur interne');
  assert.strictEqual(scrubMessage(undefined), 'Erreur interne');
  assert.strictEqual(scrubMessage({ toString: () => 'x' }), 'Erreur interne');
});

// --- fail ------------------------------------------------------------------

test('fail pose le statut, le code et la prose', () => {
  const res = fauxRes();
  fail(res, 409, 'TRUST_LIST_EMPTY', 'Cercle de confiance vide');
  assert.strictEqual(res.statut, 409);
  assert.deepStrictEqual(res.corps, {
    error: 'Cercle de confiance vide',
    code: 'TRUST_LIST_EMPTY',
  });
});

test('fail retombe sur le code quand la prose manque', () => {
  const res = fauxRes();
  fail(res, 400, 'INVALID_ETA');
  assert.strictEqual(res.corps.error, 'INVALID_ETA');
  assert.strictEqual(res.corps.code, 'INVALID_ETA');
});

test('fail assainit aussi la prose fournie', () => {
  // Un `catch (e) { fail(res, 500, 'INTERNAL', e.message) }` ne doit pas
  // rouvrir la fuite que ce module ferme.
  const res = fauxRes();
  fail(res, 500, 'INTERNAL', "ER_BAD_FIELD_ERROR: Unknown column 'x'");
  assert.strictEqual(res.corps.error, 'Erreur interne');
  assert.strictEqual(res.corps.code, 'INTERNAL');
});

test('fail accepte des champs supplémentaires', () => {
  const res = fauxRes();
  fail(res, 403, 'MEETING_PARTICIPANT_LIMIT', 'Trop de participants', { limit: 8 });
  assert.strictEqual(res.corps.limit, 8);
  assert.strictEqual(res.corps.code, 'MEETING_PARTICIPANT_LIMIT');
});

test('extra ne peut pas écraser le code ni la prose', () => {
  // `code` est le contrat : un champ d'appoint mal nommé ne doit pas le
  // détourner, sinon l'application traduirait la mauvaise erreur.
  const res = fauxRes();
  fail(res, 400, 'A', 'attendu', { code: 'B', error: 'usurpé' });
  assert.strictEqual(res.corps.code, 'A');
  assert.strictEqual(res.corps.error, 'attendu');
});

// --- failInternal ----------------------------------------------------------

test('failInternal ne laisse jamais sortir un message de driver', () => {
  const res = fauxRes();
  failInternal(res, "ER_NO_SUCH_TABLE: Table 'alanya.x' doesn't exist");
  assert.strictEqual(res.statut, 500);
  assert.deepStrictEqual(res.corps, { error: 'Erreur interne', code: CODE_INTERNE });
});

test('failInternal sans message reste neutre', () => {
  const res = fauxRes();
  failInternal(res);
  assert.deepStrictEqual(res.corps, { error: 'Erreur interne', code: CODE_INTERNE });
});

console.log(`apiError : ${ok} tests passés`);
