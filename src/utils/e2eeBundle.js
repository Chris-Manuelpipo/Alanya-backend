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
 * Les colonnes sont en VARBINARY(33) et VARBINARY(64) (migration 091), donc
 * une clé trop longue serait refusée par MySQL. Mais le message d'erreur
 * serait « Data too long for column », renvoyé en 500, et le client n'aurait
 * aucun moyen de savoir laquelle de ses douze clés est en cause. Valider ici
 * rend un 400 nommé, avec le champ fautif.
 *
 * Surtout, MySQL ne refuse PAS une clé trop COURTE : une clé de 20 octets
 * entrerait sans un mot. Elle serait publiée, servie, et tous les amorçages
 * X3DH qui s'appuieraient dessus échoueraient — côté destinataire,
 * silencieusement, des jours plus tard. C'est précisément le genre de panne
 * qu'une vérification de longueur à l'entrée supprime.
 *
 * ── Le format est celui de Signal ──
 *
 * Les clés viennent de `libsignal_protocol_dart`. Une clé publique sérialisée
 * y fait 33 octets : l'octet de type 0x05 (« DJB », Curve25519) puis les 32
 * octets de la clé. On vérifie aussi cet octet : une clé de 33 octets qui ne
 * commence pas par 0x05 a été produite par autre chose que la bibliothèque, et
 * la bibliothèque du correspondant la refuserait au moment d'ouvrir la session
 * — loin d'ici, avec une erreur qui parle de clé invalide sans dire laquelle
 * (docs/e2ee, chapitre 8 : « vérifiez explicitement ce qui est implicite »).
 */

// Tailles du protocole Signal : clé publique Curve25519 précédée de son octet
// de type, signature XEdDSA.
const CLE_PUBLIQUE_OCTETS = 33;
const TYPE_DJB = 0x05;
const SIGNATURE_OCTETS = 64;

// `keyId` sur 24 bits : la borne de Signal (`Medium.MAX_VALUE`). Le client les
// tire d'un COMPTEUR, jamais au hasard — deux lots tirés au hasard peuvent se
// chevaucher, et le doublon écraserait une clé encore publiée (docs/e2ee,
// chapitre 13).
const KEY_ID_MAX = 0xffffff;

// `registrationId` : même borne que Signal (14 bits), par convention et pour
// rester comparable à la littérature du protocole.
const REGISTRATION_ID_MAX = 16383;

// Ce qu'une installation sait lire : 1 = texte, 2 = médias, 3 = groupes.
const CAPACITE_MIN = 1;
const CAPACITE_MAX = 3;

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
 * Décode une valeur base64 et vérifie sa taille exacte.
 *
 * `Buffer.from(x, 'base64')` ne signale JAMAIS une entrée invalide : il
 * ignore les caractères hors alphabet et rend ce qu'il a pu lire. Comparer la
 * longueur du résultat est donc la seule façon de détecter une base64
 * abîmée — et c'est aussi ce qui attrape la clé tronquée.
 */
function decodeOctets(valeur, champ, octetsAttendus) {
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

/** Clé publique Signal : 33 octets, et l'octet de type Curve25519 en tête. */
function decodeCle(valeur, champ) {
  const buf = decodeOctets(valeur, champ, CLE_PUBLIQUE_OCTETS);
  if (buf[0] !== TYPE_DJB) {
    throw new BundleInvalide(
      'E2EE_CLE_TYPE',
      `${champ} doit commencer par l'octet de type 0x05 (Curve25519)`,
      champ,
    );
  }
  return buf;
}

/** Signature XEdDSA : 64 octets, sans octet de type. */
function decodeSignature(valeur, champ) {
  return decodeOctets(valeur, champ, SIGNATURE_OCTETS);
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
    signature: decodeSignature(entree.signature, `${prefixe}.signature`),
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
    identityKey: decodeCle(corps.identityKey, 'identityKey'),
    capacite: normaliseCapacite(corps.capacite),
    signedPreKey: normaliseSignedPreKey(corps.signedPreKey),
    oneTimePreKeys: normaliseOneTimePreKeys(corps.oneTimePreKeys),
  };
}

/**
 * Capacité de l'installation, obligatoire.
 *
 * Pas de valeur par défaut : une application qui publie sans dire ce qu'elle
 * sait lire recevrait des formes de message qu'elle afficherait en charabia.
 */
function normaliseCapacite(valeur) {
  const n = Number(valeur);
  if (!Number.isInteger(n) || n < CAPACITE_MIN || n > CAPACITE_MAX) {
    throw new BundleInvalide(
      'E2EE_CAPACITE_INVALIDE',
      `capacite doit être un entier de ${CAPACITE_MIN} à ${CAPACITE_MAX}`,
      'capacite',
    );
  }
  return n;
}

/** Rend un bundle lu en base sous la forme attendue par le client. */
function bundleSortie(ligne, oneTimePreKey = null) {
  return {
    appareilId: Number(ligne.appareil_id),
    alanyaID: Number(ligne.alanyaID),
    registrationId: Number(ligne.registration_id),
    identityKey: ligne.identity_key.toString('base64'),
    capacite: Number(ligne.capacite),
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
  TYPE_DJB,
  SIGNATURE_OCTETS,
  KEY_ID_MAX,
  REGISTRATION_ID_MAX,
  CAPACITE_MIN,
  CAPACITE_MAX,
  OTPK_PAR_ENVOI_MAX,
  decodeCle,
  decodeSignature,
  entierBorne,
  normaliseCapacite,
  normaliseSignedPreKey,
  normaliseOneTimePreKeys,
  normaliseBundle,
  bundleSortie,
};
