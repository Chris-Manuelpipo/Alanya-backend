// Code de récupération de compte : génération, chiffrement, comparaison.
//
// Pourquoi ce mécanisme existe : l'adresse e-mail est FACULTATIVE à l'inscription
// et `forgot-password` n'interroge que users.email. Un utilisateur qui s'inscrit
// sans e-mail et oublie son mot de passe n'a donc aujourd'hui aucune voie de
// retour — le login se fait par alanyaPhone + mot de passe, rien d'autre. Le code
// de récupération est cette voie de retour : il prouve la possession du compte
// sans dépendre d'un canal externe.
//
// Chiffré, et non haché comme un mot de passe : le propriétaire doit pouvoir le
// RECONSULTER (Mon compte → Sécurité) longtemps après l'inscription, sinon un
// code égaré ramène exactement au problème qu'il devait résoudre. Le chiffrement
// AES-256-GCM garde la propriété qui compte ici : une fuite de la seule base ne
// suffit pas à lire les codes, il faut aussi la clé applicative.
//
// ⚠ ROTATION DE CLÉ : changer RECOVERY_CODE_KEY (ou JWT_SECRET si l'on est sur le
// repli ci-dessous) rend TOUS les codes déjà émis indéchiffrables. Leurs
// propriétaires perdent leur voie de récupération sans aucun signal. Ne jamais la
// changer sans avoir prévu de régénérer et de communiquer les nouveaux codes.

const crypto = require('crypto');
const { secretMatches } = require('../utils/qrToken');

// Alphabet sans 0/1/I/L/O/U : ces caractères se confondent à la lecture, et un
// code de récupération est fait pour être recopié à la main depuis un bout de
// papier, souvent des mois plus tard.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const GROUP_SIZE = 4;

const ENC_VERSION = 'v1';
const IV_BYTES = 12; // recommandation GCM

let _cleCache;

/**
 * Clé de chiffrement 32 octets. RECOVERY_CODE_KEY (base64) si posée, sinon
 * dérivée de JWT_SECRET : un déploiement existant continue de fonctionner sans
 * nouvelle variable d'environnement, au prix d'un couplage qu'on signale.
 */
const _cle = () => {
  if (_cleCache) return _cleCache;

  const brute = process.env.RECOVERY_CODE_KEY;
  if (brute) {
    const octets = Buffer.from(brute, 'base64');
    if (octets.length !== 32) {
      throw new Error('RECOVERY_CODE_KEY doit faire 32 octets en base64 (openssl rand -base64 32)');
    }
    _cleCache = octets;
    return _cleCache;
  }

  console.warn(
    '[recoveryCode] RECOVERY_CODE_KEY absente — clé dérivée de JWT_SECRET. ' +
    'Changer JWT_SECRET rendra tous les codes de récupération illisibles.',
  );
  const secret = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';
  _cleCache = crypto.scryptSync(secret, 'alanya-recovery-code-v1', 32);
  return _cleCache;
};

/** Code lisible « XXXX-XXXX-XXXX ». 30^12 ≈ 5×10^17 : non devinable. */
const generateRecoveryCode = () => {
  // randomInt plutôt qu'un modulo sur randomBytes : pas de biais de distribution.
  let brut = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    brut += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return brut.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')).join('-');
};

/**
 * Forme canonique d'un code saisi : l'utilisateur peut le taper en minuscules,
 * avec ou sans tirets, avec des espaces collés par le presse-papiers.
 */
const normalize = (valeur) =>
  String(valeur ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Remet les tirets pour l'affichage. */
const format = (code) => {
  const canonique = normalize(code);
  if (!canonique) return '';
  return canonique.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')).join('-');
};

/** @returns {string} `v1:<iv>:<tag>:<ciphertext>`, tous en base64. */
const encrypt = (code) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const chiffreur = crypto.createCipheriv('aes-256-gcm', _cle(), iv);
  const chiffre = Buffer.concat([
    chiffreur.update(normalize(code), 'utf8'),
    chiffreur.final(),
  ]);
  const tag = chiffreur.getAuthTag();
  return [ENC_VERSION, iv.toString('base64'), tag.toString('base64'), chiffre.toString('base64')].join(':');
};

/**
 * @returns {string|null} le code canonique, ou null si la valeur est absente,
 *   malformée, ou chiffrée avec une autre clé. Ne lève jamais : un code
 *   indéchiffrable doit dégrader le parcours, pas renvoyer une 500.
 */
const decrypt = (stocke) => {
  if (!stocke) return null;
  try {
    const [version, ivB64, tagB64, chiffreB64] = String(stocke).split(':');
    if (version !== ENC_VERSION || !ivB64 || !tagB64 || !chiffreB64) return null;

    const dechiffreur = crypto.createDecipheriv(
      'aes-256-gcm',
      _cle(),
      Buffer.from(ivB64, 'base64'),
    );
    dechiffreur.setAuthTag(Buffer.from(tagB64, 'base64'));
    const clair = Buffer.concat([
      dechiffreur.update(Buffer.from(chiffreB64, 'base64')),
      dechiffreur.final(),
    ]);
    return clair.toString('utf8');
  } catch (error) {
    console.warn('[recoveryCode] déchiffrement échoué:', error.message);
    return null;
  }
};

/**
 * Comparaison à temps constant (secretMatches) entre un code stocké chiffré et
 * une saisie utilisateur. Le seul point de vérité pour « ce code est le bon ».
 */
const matches = (stocke, saisie) => {
  const attendu = decrypt(stocke);
  if (!attendu) return false;
  return secretMatches(attendu, normalize(saisie));
};

/** Code neuf + sa forme chiffrée, prêts pour un INSERT et un affichage unique. */
const issue = () => {
  const code = generateRecoveryCode();
  return { code, encrypted: encrypt(code) };
};

module.exports = {
  generateRecoveryCode,
  normalize,
  format,
  encrypt,
  decrypt,
  matches,
  issue,
};
