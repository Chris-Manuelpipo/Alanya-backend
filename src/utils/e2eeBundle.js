/**
 * Validation et normalisation des bundles de clés publiques (E2EE).
 *
 * Module pur : aucune base, aucun réseau. Tout ce qui décide si un bundle est
 * acceptable vit ici, pour que les cas limites — clé tronquée, base64
 * invalide, `keyId` hors bornes, stock démesuré — soient rejouables sans
 * MySQL ni téléphone.
 *
 * ── Pourquoi valider les tailles alors que la base les impose déjà ──
 *
 * Les colonnes sont en VARBINARY(32) et VARBINARY(64) (migration 091), donc
 * une clé trop longue serait refusée par MySQL. Mais le message d'erreur
 * serait « Data too long for column », renvoyé en 500, et le client n'aurait
 * aucun moyen de savoir laquelle de ses douze clés est en cause. Valider ici
 * rend un 400 nommé, avec le champ fautif.
 *
 * Surtout, MySQL ne refuse PAS une clé trop COURTE : une clé X25519 de 20
 * octets entrerait sans un mot. Elle serait publiée, servie, et tous les
 * amorçages X3DH qui s'appuieraient dessus échoueraient — côté destinataire,
 * silencieusement, des jours plus tard. C'est précisément le genre de panne
 * qu'une vérification de longueur à l'entrée supprime.
 */

// Tailles du protocole. X25519 et Ed25519 ont la même taille de clé publique
// (32 octets) ; une signature Ed25519 en fait 64.
const CLE_PUBLIQUE_OCTETS = 32;
const SIGNATURE_OCTETS = 64;

// `keyId` sur 16 bits : c'est ce que le client tire au hasard, et ce que
// l'en-tête d'amorçage transporte. Au-delà, la valeur ne tiendrait plus dans
// l'en-tête sans l'élargir — et 65 536 identifiants suffisent très largement
// pour un stock qui plafonne à 100.
const KEY_ID_MAX = 0xffff;

// `registrationId` : même borne que Signal (14 bits), par convention et pour
// rester comparable à la littérature du protocole.
const REGISTRATION_ID_MAX = 16383;

// Plafond d'un envoi de clés à usage unique. Cent par appareil est déjà
// confortable (le client regarnit dès qu'il tombe sous 20) ; sans plafond, un
// client fautif — ou malveillant — remplirait la table à lui seul.
const OTPK_PAR_ENVOI_MAX = 100;

/** Erreur de validation : porte le code d'API et le champ fautif. */
class BundleInvalide extends Error {
  constructor(code, message, champ) {
    super(message);
    this.code = code;
    this.champ = champ;
  }
}

/**
 * Décode une clé publique base64 et vérifie sa taille exacte.
 *
 * `Buffer.from(x, 'base64')` ne signale JAMAIS une entrée invalide : il
 * ignore les caractères hors alphabet et rend ce qu'il a pu lire. Comparer la
 * longueur du résultat est donc la seule façon de détecter une base64
 * abîmée — et c'est aussi ce qui attrape la clé tronquée.
 */
function decodeCle(valeur, champ, octetsAttendus = CLE_PUBLIQUE_OCTETS) {
  if (typeof valeur !== 'string' || valeur === '') {
    throw new BundleInvalide('E2EE_CLE_MANQUANTE', `${champ} requis`, champ);
  }
  const buf = Buffer.from(valeur, 'base64');
  if (buf.length !== octetsAttendus) {
    throw new BundleInvalide(
      'E2EE_CLE_TAILLE',
      `${champ} doit faire ${octetsAttendus} octets, ${buf.length} reçus`,
      champ,
    );
  }
  return buf;
}

/** Entier dans [0, max], refusé sinon. */
function entierBorne(valeur, champ, max) {
  const n = Number(valeur);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new BundleInvalide(
      'E2EE_ID_INVALIDE',
      `${champ} doit être un entier entre 0 et ${max}`,
      champ,
    );
  }
  return n;
}

/**
 * Normalise un signed prekey : `{ keyId, publicKey, signature }`.
 *
 * La signature n'est pas vérifiée ici — elle le sera par le DESTINATAIRE du
 * bundle, avec la clé Ed25519 de l'émetteur. La vérifier côté serveur ne
 * protégerait de rien : c'est le même acteur qui publie la clé de
 * vérification et la signature, il peut donc toujours produire un couple
 * cohérent. Seul le correspondant, qui a épinglé l'identité au premier
 * contact, est en position de constater un changement.
 */
function normaliseSignedPreKey(entree, prefixe = 'signedPreKey') {
  if (!entree || typeof entree !== 'object') {
    throw new BundleInvalide('E2EE_CLE_MANQUANTE', `${prefixe} requis`, prefixe);
  }
  return {
    keyId: entierBorne(entree.keyId, `${prefixe}.keyId`, KEY_ID_MAX),
    publicKey: decodeCle(entree.publicKey, `${prefixe}.publicKey`),
    signature: decodeCle(entree.signature, `${prefixe}.signature`, SIGNATURE_OCTETS),
  };
}

/**
 * Normalise une liste de clés à usage unique.
 *
 * Les doublons de `keyId` sont rejetés ici plutôt que laissés à l'index
 * UNIQUE : un envoi de 50 clés dont deux portent le même identifiant doit
 * échouer en entier et le dire, pas s'insérer à moitié.
 *
 * Une liste vide est valide : regarnir n'est pas obligatoire, et la
 * publication initiale doit pouvoir réussir même si le tirage des clés a
 * échoué sur l'appareil. L'amorçage se fera alors sur trois demi-échanges.
 */
function normaliseOneTimePreKeys(entree) {
  if (entree == null) return [];
  if (!Array.isArray(entree)) {
    throw new BundleInvalide(
      'E2EE_OTPK_INVALIDE',
      'oneTimePreKeys doit être une liste',
      'oneTimePreKeys',
    );
  }
  if (entree.length > OTPK_PAR_ENVOI_MAX) {
    throw new BundleInvalide(
      'E2EE_OTPK_TROP',
      `oneTimePreKeys limité à ${OTPK_PAR_ENVOI_MAX} par envoi, ${entree.length} reçues`,
      'oneTimePreKeys',
    );
  }

  const vus = new Set();
  return entree.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new BundleInvalide(
        'E2EE_OTPK_INVALIDE',
        `oneTimePreKeys[${i}] doit être un objet`,
        `oneTimePreKeys[${i}]`,
      );
    }
    const keyId = entierBorne(item.keyId, `oneTimePreKeys[${i}].keyId`, KEY_ID_MAX);
    if (vus.has(keyId)) {
      throw new BundleInvalide(
        'E2EE_OTPK_DOUBLON',
        `oneTimePreKeys : keyId ${keyId} présent deux fois`,
        `oneTimePreKeys[${i}].keyId`,
      );
    }
    vus.add(keyId);
    return {
      keyId,
      publicKey: decodeCle(item.publicKey, `oneTimePreKeys[${i}].publicKey`),
    };
  });
}

/**
 * Normalise un bundle complet, tel que le reçoit `POST /api/e2ee/keys`.
 *
 * Lève `BundleInvalide` au premier défaut : un bundle à moitié correct n'est
 * pas une identité à moitié publiable.
 */
function normaliseBundle(corps = {}) {
  return {
    registrationId: entierBorne(
      corps.registrationId, 'registrationId', REGISTRATION_ID_MAX,
    ),
    identityKeyDh: decodeCle(corps.identityKeyDh, 'identityKeyDh'),
    identityKeySign: decodeCle(corps.identityKeySign, 'identityKeySign'),
    signedPreKey: normaliseSignedPreKey(corps.signedPreKey),
    oneTimePreKeys: normaliseOneTimePreKeys(corps.oneTimePreKeys),
  };
}

/** Rend un bundle lu en base sous la forme attendue par le client. */
function bundleSortie(ligne, oneTimePreKey = null) {
  return {
    appareilId: Number(ligne.appareil_id),
    alanyaID: Number(ligne.alanyaID),
    registrationId: Number(ligne.registration_id),
    identityKeyDh: ligne.identity_key_dh.toString('base64'),
    identityKeySign: ligne.identity_key_sign.toString('base64'),
    signedPreKey: {
      keyId: Number(ligne.signed_prekey_id),
      publicKey: ligne.signed_prekey.toString('base64'),
      signature: ligne.signed_prekey_sig.toString('base64'),
    },
    // L'ancien prekey n'est publié que s'il existe encore : un correspondant
    // qui a lu le bundle avant la rotation s'en sert pour son amorçage.
    ...(ligne.prev_signed_prekey
      ? {
        prevSignedPreKey: {
          keyId: Number(ligne.prev_signed_prekey_id),
          publicKey: ligne.prev_signed_prekey.toString('base64'),
          signature: ligne.prev_signed_prekey_sig.toString('base64'),
        },
      }
      : {}),
    // `null` explicite et non champ absent : le client doit distinguer « pas
    // de clé à usage unique disponible, amorce sur trois demi-échanges » d'un
    // champ qu'il aurait oublié de lire.
    oneTimePreKey: oneTimePreKey
      ? {
        keyId: Number(oneTimePreKey.key_id),
        publicKey: oneTimePreKey.public_key.toString('base64'),
      }
      : null,
  };
}

module.exports = {
  BundleInvalide,
  CLE_PUBLIQUE_OCTETS,
  SIGNATURE_OCTETS,
  KEY_ID_MAX,
  REGISTRATION_ID_MAX,
  OTPK_PAR_ENVOI_MAX,
  decodeCle,
  entierBorne,
  normaliseSignedPreKey,
  normaliseOneTimePreKeys,
  normaliseBundle,
  bundleSortie,
};
