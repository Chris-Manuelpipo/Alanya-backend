const pool = require('../config/db');
const {
  isB2Enabled,
  storedKeyFromUrl,
  keyFromUrl,
  removeAllVersions,
} = require('../services/mediaStorage');

/// Clé Backblaze d'un fichier désigné par son URL, si elle est rangée sous
/// l'un des `prefixes` autorisés ; sinon `null`.
///
/// L'URL vient d'un client (`message.mediaUrl`, `avatar_url`, `groupPhoto`
/// s'écrivent librement) : seule une clé validée — préfixe connu, aucun `..` —
/// peut être supprimée. Et seulement sous le préfixe attendu par l'appelant.
const cleSupprimable = (url, prefixes) => {
  const key = storedKeyFromUrl(url);
  return key && prefixes.includes(key.split('/')[0]) ? key : null;
};

/// Supprime un fichier chez Backblaze, toutes versions comprises, s'il est
/// rangé sous l'un des `prefixes` autorisés. Best-effort : une erreur est
/// journalisée, jamais levée.
const supprimerFichier = (url, prefixes) => {
  if (!url || !isB2Enabled()) return;
  const key = cleSupprimable(url, prefixes);
  if (!key) return;
  removeAllVersions(key).catch((e) => {
    console.error('[MediaFile] suppression Backblaze échouée:', e.message);
  });
};

/// Supprime un média de discussion à partir de son URL
/// (`.../uploads/media/<jour>/<type>/x`). Best-effort.
///
/// Seulement sous `media/` : l'adresse d'un message s'écrit librement depuis
/// l'application, et un message « vue unique » qui désignerait la photo de
/// profil de quelqu'un d'autre la ferait sinon supprimer à son ouverture. Les
/// photos et annonces passent par `deletePublicFileIfUnused`.
///
/// Toutes les versions sont supprimées : une suppression simple ne ferait que
/// masquer le fichier jusqu'au passage quotidien des règles de cycle de vie,
/// ce qui ne convient pas à un média à vue unique consommé.
const deleteMediaFile = (mediaUrl) => supprimerFichier(mediaUrl, ['media']);

// ── Fichiers publics : photos de profil et de groupe, annonces ──────────────

/// Noms que le serveur génère lui-même à l'envoi (`newImageKey`,
/// `newVoicemailGreetingKey`, et la forme d'avant le suffixe aléatoire). Rien
/// d'autre n'est jamais supprimé ici : ni les avatars par défaut
/// (`images/default_avatar_*.png`), partagés par tous les comptes, ni un
/// fichier déposé à la main.
const NOMS_GENERES = [
  /^images\/img_\d+_\d+(_[0-9a-f]{16})?\.[a-z0-9]{1,8}$/,
  /^voicemail\/vm_\d+_\d+(_[0-9a-f]{16})?\.[a-z0-9]{1,8}$/,
];

/// Colonnes qui désignent un fichier public. Une table absente (migration pas
/// encore appliquée) ne désigne rien.
const REFERENCES = [
  'SELECT 1 FROM users WHERE avatar_url LIKE ? ESCAPE \'!\' LIMIT 1',
  'SELECT 1 FROM conversation WHERE groupPhoto LIKE ? ESCAPE \'!\' LIMIT 1',
  'SELECT 1 FROM user_voicemail_schedule WHERE greeting_url LIKE ? ESCAPE \'!\' LIMIT 1',
];

/// Motif LIKE « se termine par `/<clé>` ». Les `_` des noms de fichiers sont
/// des jokers en SQL : échappés, sinon `img_1_…` désignerait aussi `imgX1X…`.
/// La comparaison porte sur la clé et non sur l'URL entière, qui a changé
/// d'hôte au fil du temps (adresse IP, puis nom de domaine).
const motifFinissantPar = (cle) => `%/${cle.replace(/[!%_]/g, '!$&')}`;

/**
 * Supprime une photo de profil, une photo de groupe ou une annonce de
 * répondeur devenue inutile : remplacée, ou son propriétaire supprimé.
 *
 * À appeler APRÈS l'écriture qui a cessé de la désigner. Deux conditions,
 * parce que ces adresses s'écrivent librement depuis l'application :
 *  - le nom a été généré par le serveur (voir `NOMS_GENERES`) ;
 *  - plus aucune ligne ne la désigne. Sans ce contrôle, un client qui
 *    recopierait l'adresse de la photo d'un autre dans son profil, puis la
 *    remplacerait, ferait supprimer la photo de l'autre.
 *
 * Au moindre doute — base injoignable — rien n'est supprimé : le fichier
 * restera, ce qui est sans conséquence.
 *
 * @returns {Promise<boolean>} `true` si la suppression a été lancée
 */
async function deletePublicFileIfUnused(url, {
  db = pool,
  supprimer = (u) => supprimerFichier(u, ['images', 'voicemail']),
} = {}) {
  const cle = keyFromUrl(url);
  if (!cle || !NOMS_GENERES.some((re) => re.test(cle))) return false;

  const motif = motifFinissantPar(cle);
  for (const sql of REFERENCES) {
    try {
      const [rows] = await db.execute(sql, [motif]);
      if (rows.length) return false;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') continue;
      console.warn('[MediaFile] références illisibles, fichier conservé:', e.message);
      return false;
    }
  }
  supprimer(url);
  return true;
}

/// Même chose, sans attendre ni jamais faire échouer l'appelant : le fichier
/// est un détail, la requête qui l'a libéré a déjà réussi.
const releasePublicFiles = (...urls) => {
  for (const url of urls.flat()) {
    if (!url) continue;
    deletePublicFileIfUnused(url).catch((e) => {
      console.warn('[MediaFile] nettoyage impossible:', e.message);
    });
  }
};

/// Fichiers publics d'un compte (photo, annonce), à lire AVANT de le supprimer.
async function publicFilesOfUser(db, alanyaID) {
  const urls = [];
  const [users] = await db.execute('SELECT avatar_url FROM users WHERE alanyaID = ?', [alanyaID]);
  if (users[0]?.avatar_url) urls.push(users[0].avatar_url);
  try {
    const [vm] = await db.execute(
      'SELECT greeting_url FROM user_voicemail_schedule WHERE alanyaID = ?',
      [alanyaID],
    );
    if (vm[0]?.greeting_url) urls.push(vm[0].greeting_url);
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  return urls;
}

/// Photos des groupes désignés, à lire AVANT de les supprimer.
async function groupPhotosOf(db, conversIDs) {
  const ids = [].concat(conversIDs).map(Number).filter((n) => n > 0);
  if (!ids.length) return [];
  const [rows] = await db.execute(
    `SELECT groupPhoto FROM conversation
      WHERE conversID IN (${ids.map(() => '?').join(',')}) AND groupPhoto IS NOT NULL`,
    ids,
  );
  return rows.map((r) => r.groupPhoto);
}

module.exports = {
  deleteMediaFile,
  deletePublicFileIfUnused,
  releasePublicFiles,
  publicFilesOfUser,
  groupPhotosOf,
  _cleSupprimable: cleSupprimable,
};
