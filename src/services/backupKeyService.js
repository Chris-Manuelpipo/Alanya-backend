const crypto = require('crypto');
const pool = require('../config/db');

/** Marqueur posé par la migration 069. Refusé tant qu'il n'a pas été remplacé. */
const PLACEHOLDER_SECRET = 'REMPLACER_AU_DEPLOIEMENT';

/** Longueur attendue de la clé servie : AES-256. */
const KEY_BYTES = 32;

/**
 * Dérivation de la clé de sauvegarde d'un compte.
 *
 * ── Pourquoi HKDF et non un simple hachage ──
 *
 * On veut, à partir d'un secret maître, autant de clés indépendantes qu'il y a
 * de comptes. HKDF est fait pour cela : le sel et l'étiquette garantissent que
 * deux comptes obtiennent des clés sans relation exploitable, même si l'un
 * d'eux connaît la sienne.
 *
 * L'étiquette porte le numéro de version : deux versions du même secret — ce
 * qui n'arrivera pas, mais coûte zéro à couvrir — ne pourraient pas produire la
 * même clé pour le même compte.
 *
 * ── Conséquence à assumer ──
 *
 * Le serveur peut dériver la clé de n'importe quel compte, donc déchiffrer
 * n'importe quelle sauvegarde. Ce n'est PAS du chiffrement de bout en bout, et
 * l'application le dit à l'inscrit. C'est l'arbitrage retenu contre
 * l'alternative — un mot de passe choisi par lui — dont le mode de panne (mot
 * de passe oublié = sauvegarde perdue à jamais) est le premier motif de
 * support sur ce type de fonction.
 *
 * C'est aussi pourquoi les accès à ce service sont journalisés : la trace
 * d'audit fait la différence entre « Alanya peut déchiffrer », phrase
 * inquiétante, et « Alanya peut déchiffrer, et chaque accès laisse une trace »,
 * phrase défendable devant un inscrit comme devant un régulateur.
 */
function deriveKey(secretB64, kid, alanyaID) {
  const master = Buffer.from(secretB64, 'base64');
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      master,
      Buffer.from(String(alanyaID), 'utf8'), // sel : le compte
      Buffer.from(`alanya-backup-v${kid}`, 'utf8'), // étiquette : la version
      KEY_BYTES
    )
  );
}

/** Le secret n'a pas été remplacé, ou n'existe pas. */
class BackupSecretUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupSecretUnavailable';
  }
}

async function _loadSecret(where, params) {
  const [rows] = await pool.execute(
    `SELECT kid, secret FROM backup_key_secrets WHERE ${where} LIMIT 1`,
    params
  );
  if (rows.length === 0) {
    throw new BackupSecretUnavailable('aucun secret de sauvegarde');
  }
  if (rows[0].secret === PLACEHOLDER_SECRET) {
    // Servir cette valeur reviendrait à chiffrer toutes les sauvegardes avec
    // un secret figurant en clair dans le dépôt. Mieux vaut refuser la
    // sauvegarde que la rendre inutile en donnant l'illusion du contraire.
    throw new BackupSecretUnavailable(
      'le secret de sauvegarde n\'a pas été remplacé au déploiement'
    );
  }
  return rows[0];
}

/**
 * Version courante : la plus récente qui n'a pas été retirée.
 *
 * Retirer une version (`retired_at`) l'écarte des NOUVELLES sauvegardes, sans
 * jamais l'empêcher d'en relire d'anciennes — c'est tout le mécanisme de la
 * rotation.
 */
async function currentKey(alanyaID) {
  const row = await _loadSecret(
    'retired_at IS NULL ORDER BY kid DESC',
    []
  );
  return { kid: row.kid, key: deriveKey(row.secret, row.kid, alanyaID) };
}

/**
 * Version précise, pour relire une archive ancienne.
 *
 * Sert les versions retirées : c'est justement leur raison d'être.
 */
async function keyByKid(alanyaID, kid) {
  const row = await _loadSecret('kid = ?', [kid]);
  return { kid: row.kid, key: deriveKey(row.secret, row.kid, alanyaID) };
}

module.exports = {
  currentKey,
  keyByKid,
  deriveKey,
  BackupSecretUnavailable,
  PLACEHOLDER_SECRET,
  KEY_BYTES,
};
