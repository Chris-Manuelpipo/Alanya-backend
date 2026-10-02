/**
 * `node src/utils/e2eeBundle.test.js`
 *
 * Ce que ce test protège vraiment : la clé TROP COURTE. MySQL refuse une clé
 * trop longue (VARBINARY(32)) mais accepte sans un mot une clé de 20 octets,
 * qui serait alors publiée, servie à des correspondants, et ferait échouer
 * tous leurs amorçages X3DH — chez eux, silencieusement, des jours plus tard.
 * C'est la panne la plus coûteuse à diagnostiquer de tout le chiffrement, et
 * elle se ferme ici en une comparaison de longueur.
 */

const assert = require('assert');
const {
  BundleInvalide,
  KEY_ID_MAX,
  REGISTRATION_ID_MAX,
  OTPK_PAR_ENVOI_MAX,
  normaliseBundle,
  normaliseOneTimePreKeys,
  normaliseSignedPreKey,
  bundleSortie,
} = require('./e2eeBundle');

const b64 = (n, remplissage = 7) => Buffer.alloc(n, remplissage).toString('base64');
const cle = () => b64(32);
const sig = () => b64(64);

const bundleValide = () => ({
  registrationId: 4242,
  identityKeyDh: cle(),
  identityKeySign: b64(32, 9),
  signedPreKey: { keyId: 17, publicKey: b64(32, 11), signature: sig() },
  oneTimePreKeys: [
    { keyId: 1, publicKey: b64(32, 1) },
    { keyId: 2, publicKey: b64(32, 2) },
  ],
});

/** Attend un `BundleInvalide` portant ce code. */
function refuse(fn, code, propos) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BundleInvalide, `${propos} : BundleInvalide attendu, reçu ${e}`);
    assert.strictEqual(e.code, code, `${propos} : code ${code} attendu, reçu ${e.code}`);
    assert.ok(e.champ, `${propos} : le champ fautif doit être nommé`);
    return;
  }
  assert.fail(`${propos} : aurait dû être refusé`);
}

// ── Le cas nominal passe, et rend des Buffer aux bonnes tailles ───────────

const b = normaliseBundle(bundleValide());
assert.strictEqual(b.registrationId, 4242);
assert.strictEqual(b.identityKeyDh.length, 32, 'identityKeyDh doit faire 32 octets');
assert.strictEqual(b.identityKeySign.length, 32, 'identityKeySign doit faire 32 octets');
assert.strictEqual(b.signedPreKey.signature.length, 64, 'la signature doit faire 64 octets');
assert.strictEqual(b.oneTimePreKeys.length, 2);
assert.ok(Buffer.isBuffer(b.oneTimePreKeys[0].publicKey), 'les OTPK doivent être des Buffer');

// ── La clé trop courte : la raison d'être de ce fichier ───────────────────

refuse(
  () => normaliseBundle({ ...bundleValide(), identityKeyDh: b64(20) }),
  'E2EE_CLE_TAILLE',
  'clé X25519 de 20 octets',
);
refuse(
  () => normaliseBundle({ ...bundleValide(), identityKeyDh: b64(64) }),
  'E2EE_CLE_TAILLE',
  'clé X25519 de 64 octets',
);
refuse(
  () => normaliseSignedPreKey({ keyId: 1, publicKey: cle(), signature: b64(32) }),
  'E2EE_CLE_TAILLE',
  'signature Ed25519 de 32 octets',
);

// Base64 abîmée : `Buffer.from` ne signale rien, il rend ce qu'il a pu lire.
// C'est encore la longueur qui l'attrape.
refuse(
  () => normaliseBundle({ ...bundleValide(), identityKeySign: 'pas du base64 !!' }),
  'E2EE_CLE_TAILLE',
  'base64 invalide',
);

// ── Champs manquants ──────────────────────────────────────────────────────

refuse(
  () => normaliseBundle({ ...bundleValide(), identityKeyDh: undefined }),
  'E2EE_CLE_MANQUANTE',
  'identityKeyDh absent',
);
refuse(
  () => normaliseBundle({ ...bundleValide(), signedPreKey: undefined }),
  'E2EE_CLE_MANQUANTE',
  'signedPreKey absent',
);
refuse(
  () => normaliseBundle({ ...bundleValide(), identityKeyDh: '' }),
  'E2EE_CLE_MANQUANTE',
  'identityKeyDh vide',
);

// ── Bornes des identifiants ───────────────────────────────────────────────

refuse(
  () => normaliseBundle({ ...bundleValide(), registrationId: REGISTRATION_ID_MAX + 1 }),
  'E2EE_ID_INVALIDE',
  'registrationId hors bornes',
);
refuse(
  () => normaliseBundle({ ...bundleValide(), registrationId: -1 }),
  'E2EE_ID_INVALIDE',
  'registrationId négatif',
);
refuse(
  () => normaliseSignedPreKey({ keyId: KEY_ID_MAX + 1, publicKey: cle(), signature: sig() }),
  'E2EE_ID_INVALIDE',
  'keyId hors bornes',
);
refuse(
  () => normaliseBundle({ ...bundleValide(), registrationId: 1.5 }),
  'E2EE_ID_INVALIDE',
  'registrationId non entier',
);

// ── Clés à usage unique ───────────────────────────────────────────────────

// Liste vide : valide. La publication doit réussir même si le tirage des clés
// a échoué sur l'appareil — l'amorçage se fera sur trois demi-échanges.
assert.deepStrictEqual(normaliseOneTimePreKeys(undefined), []);
assert.deepStrictEqual(normaliseOneTimePreKeys([]), []);

// Le doublon est refusé ICI, pas laissé à l'index UNIQUE : un envoi de 50
// clés dont deux se télescopent doit échouer en entier, pas s'insérer à
// moitié.
refuse(
  () => normaliseOneTimePreKeys([
    { keyId: 5, publicKey: cle() },
    { keyId: 5, publicKey: b64(32, 3) },
  ]),
  'E2EE_OTPK_DOUBLON',
  'keyId en double',
);

refuse(
  () => normaliseOneTimePreKeys(
    Array.from({ length: OTPK_PAR_ENVOI_MAX + 1 }, (_, i) => ({
      keyId: i, publicKey: cle(),
    })),
  ),
  'E2EE_OTPK_TROP',
  'plus de 100 clés en un envoi',
);

refuse(() => normaliseOneTimePreKeys('non'), 'E2EE_OTPK_INVALIDE', 'liste qui n\'est pas une liste');
refuse(() => normaliseOneTimePreKeys([null]), 'E2EE_OTPK_INVALIDE', 'élément nul dans la liste');

// Pile au plafond : accepté.
assert.strictEqual(
  normaliseOneTimePreKeys(
    Array.from({ length: OTPK_PAR_ENVOI_MAX }, (_, i) => ({ keyId: i, publicKey: cle() })),
  ).length,
  OTPK_PAR_ENVOI_MAX,
  'le plafond lui-même doit passer',
);

// ── Sortie vers le client ─────────────────────────────────────────────────

const ligne = {
  appareil_id: 12,
  alanyaID: 34,
  registration_id: 4242,
  identity_key_dh: Buffer.alloc(32, 7),
  identity_key_sign: Buffer.alloc(32, 9),
  signed_prekey_id: 17,
  signed_prekey: Buffer.alloc(32, 11),
  signed_prekey_sig: Buffer.alloc(64, 13),
  prev_signed_prekey_id: null,
  prev_signed_prekey: null,
  prev_signed_prekey_sig: null,
};

const sortieSansOtpk = bundleSortie(ligne, null);
assert.strictEqual(sortieSansOtpk.appareilId, 12);
assert.strictEqual(sortieSansOtpk.identityKeyDh, b64(32, 7));
assert.strictEqual(sortieSansOtpk.signedPreKey.keyId, 17);
// `null` explicite, jamais absent : le client doit pouvoir distinguer « pas
// de clé à usage unique disponible » d'un champ qu'il aurait oublié de lire.
assert.ok(
  'oneTimePreKey' in sortieSansOtpk,
  'oneTimePreKey doit être présent, à null, quand le stock est vide',
);
assert.strictEqual(sortieSansOtpk.oneTimePreKey, null);
assert.ok(
  !('prevSignedPreKey' in sortieSansOtpk),
  'prevSignedPreKey doit être absent quand il n\'y a pas d\'ancien prekey',
);

const sortieAvecPrev = bundleSortie(
  {
    ...ligne,
    prev_signed_prekey_id: 16,
    prev_signed_prekey: Buffer.alloc(32, 21),
    prev_signed_prekey_sig: Buffer.alloc(64, 23),
  },
  { key_id: 3, public_key: Buffer.alloc(32, 5) },
);
assert.strictEqual(sortieAvecPrev.prevSignedPreKey.keyId, 16);
assert.strictEqual(sortieAvecPrev.oneTimePreKey.keyId, 3);
assert.strictEqual(sortieAvecPrev.oneTimePreKey.publicKey, b64(32, 5));

// Aller-retour : ce que le serveur rend se redécode aux mêmes octets que ce
// qu'il a reçu. Sans cette vérification, une erreur d'encodage ne se verrait
// qu'au premier message illisible.
const allerRetour = normaliseBundle({
  ...bundleValide(),
  identityKeyDh: sortieSansOtpk.identityKeyDh,
});
assert.ok(
  allerRetour.identityKeyDh.equals(ligne.identity_key_dh),
  'base64 → Buffer → base64 doit rendre les mêmes octets',
);

console.log('e2eeBundle.test.js OK');
