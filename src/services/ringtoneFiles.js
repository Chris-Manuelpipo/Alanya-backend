/**
 * Fichiers des sonneries importées, choisies pour une liste.
 *
 * La liste n'enregistre que l'identité d'une sonnerie importée : l'empreinte
 * SHA-256 de son contenu (`*_sound_id`, type `custom`). Le fichier est déposé
 * dans `profilemedia`, sous une clé que le serveur recalcule à partir du compte
 * et de l'empreinte (`ringtoneKey`) : aucune colonne en plus, et un nouvel
 * appareil reçoit l'adresse avec les réglages de la liste.
 *
 * Un fichier vit tant qu'une liste du compte l'utilise. « Sonneries par
 * liste » étant une fonctionnalité payante, la purge des données payantes et
 * la suppression du compte emportent tout le dossier du compte.
 *
 * Conception : docs/conception/medias-buckets.html, section 05.
 */

const pool = require('../config/db');
const storage = require('./mediaStorage');

/**
 * Un fichier plus jeune que ça n'est jamais nettoyé : l'application dépose la
 * sonnerie AVANT d'enregistrer la liste qui la désigne. Un nettoyage lancé
 * entre les deux supprimerait l'envoi qui vient de réussir.
 */
const DELAI_DE_GRACE_MS = 60 * 60 * 1000;

/** Adresse du fichier d'un son de liste, ou `null` (son fourni, ou rien à servir). */
function soundUrl(alanyaID, type, id) {
  if (type !== 'custom' || !id) return null;
  return storage.ringtoneUrl({ alanyaID, sha256: id });
}

/**
 * Supprime les sonneries du compte qu'aucune liste n'utilise plus.
 *
 * @param {number} alanyaID
 * @param {object} [opts]
 * @param {boolean} [opts.tout]  tout le dossier, sans délai de grâce : purge
 *   des données payantes, suppression du compte
 * @returns {Promise<number>} nombre de fichiers supprimés
 */
async function cleanRingtones(alanyaID, { tout = false, db = pool, now = Date.now() } = {}) {
  const compte = Number(alanyaID);
  if (!(compte > 0) || !storage.isB2Enabled()) return 0;
  // Sans secret, aucune clé ne se recalcule : tout paraîtrait orphelin.
  if (!tout && !process.env.RINGTONE_KEY_SECRET) return 0;

  const fichiers = await storage.listPrefix(`ringtones/${compte}/`);
  if (!fichiers.length) return 0;

  const gardees = new Set();
  if (!tout) {
    const [listes] = await db.execute(
      `SELECT msg_sound_type, msg_sound_id, call_sound_type, call_sound_id
         FROM contact_list WHERE alanyaID = ?`,
      [compte],
    );
    for (const l of listes) {
      for (const [type, id] of [[l.msg_sound_type, l.msg_sound_id], [l.call_sound_type, l.call_sound_id]]) {
        if (type !== 'custom' || !id) continue;
        const key = storage.ringtoneKey({ alanyaID: compte, sha256: id });
        if (key) gardees.add(key);
      }
    }
  }

  let supprimes = 0;
  for (const f of fichiers) {
    if (gardees.has(f.key)) continue;
    if (!tout && now - f.lastModified < DELAI_DE_GRACE_MS) continue;
    // eslint-disable-next-line no-await-in-loop
    await storage.removeAllVersions(f.key);
    supprimes += 1;
  }
  return supprimes;
}

/** Même chose, sans attendre ni jamais faire échouer l'appelant. */
function releaseRingtones(alanyaID, opts) {
  cleanRingtones(alanyaID, opts).catch((e) => {
    console.warn('[Ringtones] nettoyage impossible:', e.message);
  });
}

module.exports = { soundUrl, cleanRingtones, releaseRingtones, DELAI_DE_GRACE_MS };
