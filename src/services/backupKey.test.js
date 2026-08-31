const assert = require('assert');
const { deriveKey, KEY_BYTES } = require('./backupKeyService');
const { _maskEmail } = require('../controllers/backupController');

// Dérivation des clés de sauvegarde et masquage de l'adresse Google.
//
// Ce qui est éprouvé ici est ce qui, mal fait, ne se verrait qu'à la
// restauration — c'est-à-dire le jour où l'inscrit en a le plus besoin.

const SECRET = Buffer.from('a'.repeat(32), 'utf8').toString('base64');
const AUTRE_SECRET = Buffer.from('b'.repeat(32), 'utf8').toString('base64');

(() => {
  // ── Longueur ────────────────────────────────────────────────────────
  const k = deriveKey(SECRET, 1, 241030112);
  assert.strictEqual(k.length, KEY_BYTES, 'AES-256 attend 32 octets');

  // ── Déterminisme ────────────────────────────────────────────────────
  // Sans cela, une sauvegarde ne se relirait jamais : la clé de restauration
  // différerait de celle du chiffrement.
  assert.deepStrictEqual(
    deriveKey(SECRET, 1, 241030112),
    deriveKey(SECRET, 1, 241030112),
    'la dérivation doit être reproductible'
  );

  // ── Isolation entre comptes ─────────────────────────────────────────
  // C'est CE point qui autorise le rattachement souple : une archive du
  // compte A posée dans le Drive de B reste illisible pour B.
  assert.notDeepStrictEqual(
    deriveKey(SECRET, 1, 111),
    deriveKey(SECRET, 1, 222),
    'deux comptes ne doivent jamais partager une clé'
  );

  // ── Isolation entre versions ────────────────────────────────────────
  // Sans quoi la rotation ne servirait à rien : le nouveau secret produirait
  // les mêmes clés que l'ancien.
  assert.notDeepStrictEqual(
    deriveKey(SECRET, 1, 111),
    deriveKey(SECRET, 2, 111),
    'deux versions ne doivent pas produire la même clé'
  );
  assert.notDeepStrictEqual(
    deriveKey(SECRET, 1, 111),
    deriveKey(AUTRE_SECRET, 1, 111),
    'deux secrets ne doivent pas produire la même clé'
  );

  // ── Masquage de l'adresse ───────────────────────────────────────────
  // On ne conserve jamais l'adresse complète : la première lettre et le
  // domaine suffisent à guider vers le bon compte le jour de la restauration.
  assert.strictEqual(_maskEmail('ama.nguema@gmail.com'), 'a•••@gmail.com');
  assert.strictEqual(_maskEmail('x@a.fr'), 'x•••@a.fr');
  assert.ok(
    !_maskEmail('ama.nguema@gmail.com').includes('nguema'),
    'le masque ne doit rien laisser filtrer du nom'
  );

  // Entrées douteuses : on préfère ne rien stocker à stocker n'importe quoi.
  assert.strictEqual(_maskEmail(''), null);
  assert.strictEqual(_maskEmail('sans-arobase'), null);
  assert.strictEqual(_maskEmail('@domaine.fr'), null);
  assert.strictEqual(_maskEmail('fin@'), null);
  assert.strictEqual(_maskEmail(null), null);
  assert.strictEqual(_maskEmail(undefined), null);

  console.log('backupKey.test.js OK');
})();
