/**
 * Stockage objet des médias, par l'API compatible S3 : Cloudflare R2 pour les
 * médias de discussion, Backblaze B2 pour les fichiers publics.
 *
 * Conception : docs/conception/medias-backblaze.html.
 *
 * ── Ce qui ne change pas ──
 *
 * L'adresse publique d'un média reste `BASE_URL/uploads/<clé>`, et la clé B2
 * est exactement le chemin qui suit `/uploads/`. Les URL déjà en base, les
 * caches de l'application et le calcul d'expiration côté client (qui lit la
 * date dans le chemin) restent donc valables sans une seule écriture en base.
 * Le serveur répond à cette adresse par une redirection vers un lien signé
 * (voir `middleware/mediaRead.js`) : le bucket reste privé.
 *
 * ── Le stockage objet est obligatoire ──
 *
 * Aucun média n'est plus rangé ni lu sur le disque du serveur (retrait du
 * stockage disque, 28/09/2026). Sans bucket privé entièrement configuré, tout
 * envoi et toute lecture de média répondent 503 `STORAGE_UNAVAILABLE` : jamais
 * de repli silencieux vers le disque.
 *
 * ── Trois buckets ──
 *
 * Conception : docs/conception/medias-buckets.html. Le préfixe de la clé
 * décide du bucket, sans rien demander au client :
 *  - `media/` : le bucket privé, lu par lien signé — `R2_BUCKET` chez
 *    Cloudflare R2 dès que `R2_ENDPOINT`, `R2_BUCKET`, `R2_KEY_ID` et
 *    `R2_APP_KEY` sont posés, sinon `B2_BUCKET` chez Backblaze ;
 *  - `images/` : `B2_PROFILE_BUCKET` (alanyaprofile), public ;
 *  - `voicemail/`, `ringtones/`, `official/`, `stickers/` : `B2_PROFILEMEDIA_BUCKET`
 *    (profilemedia), public.
 * Un fichier public est lu par son adresse Backblaze directe, sans passer par
 * ce serveur. Tant qu'un bucket public n'est pas configuré (nom et clé), ses
 * préfixes restent dans le bucket privé, comme avant.
 *
 * ── Départ du bucket privé de Backblaze ──
 *
 * Dès que R2 est configuré, les nouveaux médias y vont. Ceux d'avant sont
 * encore chez Backblaze : tant que `MEDIA_PRIVATE_MIGRATED` n'est pas posé, une
 * lecture cherche chez R2 puis chez Backblaze, une liste réunit les deux et une
 * suppression vise les deux. La copie se fait par
 * `scripts/maintenance/migrate-private-to-r2.js` ; une fois le réglage posé,
 * l'ancien bucket n'est plus jamais consulté.
 *
 * ── La purge n'est pas ici ──
 *
 * Elle est décidée par `mediaRetention.js`, message par message : 30 jours, ou
 * 365 pour un média qu'un abonné Alanya Plus peut encore demander. Un bucket
 * n'applique qu'une durée par préfixe ; ses règles de cycle de vie ne sont
 * qu'un filet (`media/` à 366 jours). Ce module ne supprime que sur demande,
 * et toujours complètement : média échu, vue unique consommée, photo ou
 * annonce remplacée.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  MEDIA_ROOT,
  LEGACY_KINDS,
  partitionDirFor,
  partitionKeyFor,
  isPartitionKey,
  uploadMsFromFileName,
} = require('../utils/mediaPartition');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Cache des octets servis : un nom de fichier n'est jamais réutilisé, donc
 * l'appareil peut garder un média indéfiniment — la règle « borner le
 * serveur, jamais l'appareil ».
 */
const CACHE_IMMUABLE = 'public, max-age=31536000, immutable';

/**
 * Préfixes servis par `/uploads`. `exports/` et le reste ne le sont jamais.
 *
 * Chacun a son rôle, et sa purge : `media/` est daté et purgé message par
 * message ; les autres (photos, annonces, sonneries, médias officiels) ne sont
 * jamais datés et ne partent que sur demande. Une annonce rangée sous `media/`
 * serait purgée comme un média de discussion.
 *
 * ⚠ Oublier un préfixe ici fait refuser ses clés par `isSafeKey`.
 */
const PREFIXES_SERVIS = [MEDIA_ROOT, 'images', 'voicemail', 'ringtones', 'official', 'stickers'];

/** Bucket public de chaque préfixe public. Tout le reste va dans le bucket privé. */
const BUCKET_PUBLIC_DU_PREFIXE = {
  images: 'profile',
  voicemail: 'profilemedia',
  ringtones: 'profilemedia',
  official: 'profilemedia',
  stickers: 'profilemedia',
};

const SEGMENT_SUR = /^[A-Za-z0-9._-]+$/;
const EXTENSION_SURE = /^\.[a-z0-9]{1,8}$/;

const lireEntier = (nom, defaut, min, max) => {
  const n = Number.parseInt(process.env[nom], 10);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, n));
};

const lireOui = (nom) => ['1', 'true', 'oui', 'yes', 'on']
  .includes(String(process.env[nom] || '').trim().toLowerCase());

const STORAGE = {
  endpoint: process.env.B2_ENDPOINT || '',
  region: process.env.B2_REGION || '',
  bucket: process.env.B2_BUCKET || '',
  keyId: process.env.B2_KEY_ID || '',
  appKey: process.env.B2_APP_KEY || '',
  downloadTtlS: lireEntier('B2_DOWNLOAD_URL_TTL_S', 3600, 60, 86400),
  uploadTtlS: lireEntier('B2_UPLOAD_URL_TTL_S', 900, 60, 3600),
  // Buckets publics : chacun sa clé d'application, limitée à lui. Une clé
  // volée n'ouvre qu'un bucket.
  publics: {
    profile: {
      bucket: process.env.B2_PROFILE_BUCKET || '',
      keyId: process.env.B2_PROFILE_KEY_ID || '',
      appKey: process.env.B2_PROFILE_APP_KEY || '',
    },
    profilemedia: {
      bucket: process.env.B2_PROFILEMEDIA_BUCKET || '',
      keyId: process.env.B2_PROFILEMEDIA_KEY_ID || '',
      appKey: process.env.B2_PROFILEMEDIA_APP_KEY || '',
    },
  },
  // Posé une fois les fichiers existants copiés dans les buckets publics
  // (scripts/maintenance/migrate-public-buckets.js). Avant, une ancienne
  // adresse `/uploads/images/…` est lue dans le bucket privé, où le fichier se
  // trouve encore ; après, elle est redirigée vers le bucket public.
  publicMigrated: lireOui('MEDIA_PUBLIC_MIGRATED'),
  // Bucket privé chez Cloudflare R2. Complet, il reçoit les médias de
  // discussion à la place de `B2_BUCKET`.
  r2: {
    endpoint: process.env.R2_ENDPOINT || '',
    bucket: process.env.R2_BUCKET || '',
    keyId: process.env.R2_KEY_ID || '',
    appKey: process.env.R2_APP_KEY || '',
  },
  // Posé une fois les médias existants copiés de Backblaze vers R2
  // (scripts/maintenance/migrate-private-to-r2.js). Avant, l'ancien bucket
  // privé est encore consulté ; après, plus jamais.
  privateMigrated: lireOui('MEDIA_PRIVATE_MIGRATED'),
};

/**
 * Point d'accès sans chemin. Le tableau de bord de Cloudflare affiche le sien
 * suivi du nom du bucket : recopié tel quel, il ferait signer des liens faux.
 */
const origineDe = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

const r2Configure = () => {
  const c = STORAGE.r2;
  return Boolean(origineDe(c.endpoint) && c.bucket && c.keyId && c.appKey);
};

/** Le bucket privé de Backblaze : celui d'origine, et celui qu'on quitte. */
const b2PriveConfigure = () =>
  Boolean(STORAGE.endpoint && STORAGE.region && STORAGE.bucket && STORAGE.keyId && STORAGE.appKey);

const configurationComplete = () => r2Configure() || b2PriveConfigure();

/**
 * `true` tant que des médias privés peuvent n'être encore que chez Backblaze :
 * R2 a pris le relais, l'ancien bucket est toujours joignable, et la copie
 * n'a pas été déclarée terminée.
 */
const ancienActif = () => r2Configure() && b2PriveConfigure() && !STORAGE.privateMigrated;

if (process.env.NODE_ENV !== 'test') {
  if (!configurationComplete()) {
    // Bruyant exprès : sans bucket privé, aucun média ne peut être déposé ni servi.
    console.error('[MediaStorage] bucket privé non configuré (R2_ENDPOINT, R2_BUCKET, R2_KEY_ID, '
      + 'R2_APP_KEY — ou B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APP_KEY) : aucun média '
      + 'ne pourra être déposé ni servi (503).');
  }
  // R2 à moitié configuré : les médias resteraient chez Backblaze sans que
  // rien ne le dise.
  const posesR2 = Object.values(STORAGE.r2).filter(Boolean).length;
  if (posesR2 > 0 && !r2Configure()) {
    console.error('[MediaStorage] R2 incomplet (point d\'accès, bucket, clé et secret requis) : '
      + 'les médias de discussion restent chez Backblaze.');
  }
  if (ancienActif()) {
    console.log('[MediaStorage] départ de Backblaze en cours : les médias de discussion vont chez R2, '
      + 'l\'ancien bucket reste consulté. Après `npm run migrate:private-r2 -- --apply`, poser '
      + 'MEDIA_PRIVATE_MIGRATED=true.');
  }
}

// Un bucket public à moitié configuré : ses fichiers resteraient dans le
// bucket privé sans que rien ne le dise.
for (const [nom, conf] of Object.entries(STORAGE.publics)) {
  const poses = [conf.bucket, conf.keyId, conf.appKey].filter(Boolean).length;
  if (poses > 0 && poses < 3) {
    console.error(`[MediaStorage] bucket public « ${nom} » incomplet (nom, clé et secret requis) : `
      + 'ses fichiers restent dans le bucket privé.');
  }
}

/**
 * `true` si le bucket privé est configuré, chez R2 ou chez Backblaze (le nom
 * date de l'époque où tout était chez Backblaze). Sans lui, aucun média : les
 * appelants répondent 503 plutôt que de chercher un disque qui n'est plus
 * utilisé.
 */
const isB2Enabled = () => configurationComplete();

// ── Clients ─────────────────────────────────────────────────────────────────

const clientsReels = new Map();
let clientDeTest = null;

/**
 * Réglages du bucket `nom` :
 *  - `prive` : les médias de discussion — chez R2 s'il est configuré, sinon
 *    chez Backblaze ;
 *  - `ancien` : le bucket privé de Backblaze, pendant qu'on le quitte ;
 *  - `profile`, `profilemedia` : les buckets publics, chez Backblaze.
 *
 * `versions` : Backblaze garde les versions d'une clé, R2 non.
 */
function reglagesDe(nom) {
  if (nom === 'prive' && r2Configure()) {
    return { ...STORAGE.r2, endpoint: origineDe(STORAGE.r2.endpoint), region: 'auto', versions: false };
  }
  const b2 = { endpoint: STORAGE.endpoint, region: STORAGE.region, versions: true };
  if (nom === 'prive' || nom === 'ancien') {
    return { ...b2, bucket: STORAGE.bucket, keyId: STORAGE.keyId, appKey: STORAGE.appKey };
  }
  return { ...b2, ...STORAGE.publics[nom] };
}

const bucketDe = (nom) => reglagesDe(nom).bucket;

/** Client configuré : sert à signer (calcul local, sans réseau) et à envoyer. */
function clientConfigure(nom = 'prive') {
  if (!clientsReels.has(nom)) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { endpoint, region, keyId, appKey } = reglagesDe(nom);
    clientsReels.set(nom, new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: keyId, secretAccessKey: appKey },
      // Les versions récentes du SDK ajoutent d'office des sommes de contrôle
      // CRC32 que des services compatibles S3 refusent. On s'en tient à celles
      // que l'API exige.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }));
  }
  return clientsReels.get(nom);
}

/** Client des requêtes réseau ; remplacé par un faux dans les tests. */
const clientEnvoi = (nom = 'prive') => clientDeTest || clientConfigure(nom);

// ── Buckets ─────────────────────────────────────────────────────────────────

/** `true` si le bucket public `nom` a un nom, une clé et un point d'accès. */
const publicConfigure = (nom) => {
  const c = STORAGE.publics[nom];
  return Boolean(c && c.bucket && c.keyId && c.appKey && STORAGE.endpoint && STORAGE.region);
};

/**
 * Où vit une clé : `{ nom, bucket, publique }`.
 *
 * Un préfixe public va dans son bucket public dès que celui-ci est configuré ;
 * sinon, comme avant, dans le bucket privé. Déployer ce code avant d'avoir
 * posé les nouvelles clés ne change donc rien.
 */
function cibleDe(key) {
  const nom = BUCKET_PUBLIC_DU_PREFIXE[String(key || '').split('/')[0]];
  if (nom && isB2Enabled() && publicConfigure(nom)) {
    return { nom, bucket: STORAGE.publics[nom].bucket, publique: true };
  }
  return { nom: 'prive', bucket: bucketDe('prive'), publique: false };
}

/** Adresse de lecture directe d'un bucket public. */
const urlPubliqueDe = (bucket) => `https://${bucket}.s3.${STORAGE.region}.backblazeb2.com`;

/** Une clé dans une URL : chaque segment encodé, les `/` gardés. */
const encoderCle = (key) => key.split('/').map(encodeURIComponent).join('/');

// ── Clés ────────────────────────────────────────────────────────────────────

/**
 * `true` si `key` peut être servie : préfixe connu, segments sûrs, aucune
 * remontée. La clé vient souvent d'une URL lue en base, elle-même écrite à
 * partir de ce qu'un client a envoyé : elle n'est jamais utilisée sans ce
 * contrôle.
 */
function isSafeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) return false;
  const segments = key.split('/');
  if (segments.length < 2 || !PREFIXES_SERVIS.includes(segments[0])) return false;
  return segments.every((s) => SEGMENT_SUR.test(s) && s !== '.' && s !== '..');
}

/** Clé d'un chemin relatif au montage `/uploads` (`/media/…`), ou `null`. */
function keyFromPath(chemin) {
  let rel = String(chemin || '').replace(/^\/+/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  return isSafeKey(rel) ? rel : null;
}

/**
 * Clé d'une URL, ou `null` : une adresse de ce serveur (`…/uploads/<clé>`),
 * ou l'adresse directe d'un bucket public — seulement pour un préfixe qui
 * appartient à ce bucket.
 */
function keyFromUrl(url) {
  if (!url) return null;
  const s = String(url).split(/[?#]/)[0];
  for (const [nom, conf] of Object.entries(STORAGE.publics)) {
    if (!conf.bucket) continue;
    const base = `${urlPubliqueDe(conf.bucket)}/`;
    if (!s.startsWith(base)) continue;
    const key = keyFromPath(s.slice(base.length));
    return key && BUCKET_PUBLIC_DU_PREFIXE[key.split('/')[0]] === nom ? key : null;
  }
  const marqueur = '/uploads/';
  const i = s.indexOf(marqueur);
  if (i === -1) return null;
  return keyFromPath(s.slice(i + marqueur.length));
}

/**
 * Clé sous laquelle un média est réellement rangé.
 *
 * Identique à [keyFromUrl], sauf pour les adresses d'avant les partitions
 * (`media/<type>/<fichier>`) : le fichier a été déplacé dans sa partition, que
 * son nom permet de recalculer — c'est la même règle que le relais de
 * `mediaExpiry.js`.
 */
function storedKeyFromUrl(url) {
  const key = keyFromUrl(url);
  if (!key) return null;
  const segments = key.split('/');
  if (segments[0] !== MEDIA_ROOT || segments.length !== 3) return key;
  const [, kind, nom] = segments;
  if (!LEGACY_KINDS.includes(kind)) return null;
  const partition = partitionKeyFor(uploadMsFromFileName(nom));
  if (!isPartitionKey(partition)) return null;
  return `${MEDIA_ROOT}/${partition}/${kind}/${nom}`;
}

/** Extension sûre (`.jpg`) tirée d'un nom de fichier, ou chaîne vide. */
function safeExt(nom) {
  const ext = path.extname(String(nom || '')).toLowerCase();
  return EXTENSION_SURE.test(ext) ? ext : '';
}

/**
 * Suffixe aléatoire des nouveaux noms. Sans lui, un nom se reconstituait à
 * partir d'un identifiant et d'une heure, alors que `/uploads` est public.
 */
const suffixeAleatoire = () => crypto.randomBytes(8).toString('hex');

/** Clé d'un nouveau média de message : `media/<jour>/<type>/media_<id>_<ms>_<hasard><ext>`. */
function newMediaKey({ kind, alanyaID, ext = '', instant = Date.now() }) {
  if (!LEGACY_KINDS.includes(kind)) throw new Error(`type de média inconnu : ${kind}`);
  const dossier = partitionDirFor(kind, instant);
  return `${dossier}/media_${Number(alanyaID)}_${instant}_${suffixeAleatoire()}${ext}`;
}

/** Clé d'une nouvelle image de profil ou de groupe : `images/img_<id>_<ms>_<hasard><ext>`. */
function newImageKey({ alanyaID, ext = '', instant = Date.now() }) {
  return `images/img_${Number(alanyaID)}_${instant}_${suffixeAleatoire()}${ext}`;
}

/**
 * Clé d'une nouvelle annonce de répondeur : `voicemail/vm_<id>_<ms>_<hasard><ext>`.
 *
 * Le suffixe aléatoire n'est pas seulement une protection contre les URL
 * devinables, comme pour les images : ici il fait office d'EMPREINTE. Le cache
 * média de l'application indexe par le dernier segment de l'URL, sans aucune
 * invalidation par contenu ni durée de vie. Une annonce servie sous un nom
 * stable serait donc jouée éternellement dans sa première version, même
 * réenregistrée. En changeant de nom à chaque enregistrement, on obtient
 * l'invalidation gratuitement — et l'ancien fichier est supprimé.
 */
function newVoicemailGreetingKey({ alanyaID, ext = '', instant = Date.now() }) {
  return `voicemail/vm_${Number(alanyaID)}_${instant}_${suffixeAleatoire()}${ext}`;
}

/**
 * Clé d'un média officiel (diffusion, message d'accueil) :
 * `official/<type>/off_<ms>_<hasard><ext>`. Jamais daté : un média officiel
 * n'expire pas, et la purge des discussions ne voit que `media/`.
 */
function newOfficialKey({ kind, ext = '', instant = Date.now() }) {
  if (!LEGACY_KINDS.includes(kind)) throw new Error(`type de média inconnu : ${kind}`);
  return `official/${kind}/off_${instant}_${suffixeAleatoire()}${ext}`;
}

/**
 * Clé d'un sticker officiel : `official/stickers/<pack>/<sid>_<sha8>[_t].webp`.
 * Jamais purgé (préfixe `official/`). L'empreinte est dans le nom : un fichier
 * modifié change de nom, et le cache de l'application indexe par nom.
 */
function officialStickerKey({ pack, sid, sha256, thumb = false }) {
  const code = String(pack || '');
  const empreinte = String(sha256 || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(code)) throw new Error(`pack de sticker invalide : ${code}`);
  if (!/^[0-9a-f]{64}$/.test(empreinte)) throw new Error('empreinte de sticker invalide');
  const id = Number(sid);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('identifiant de sticker invalide');
  return `official/stickers/${code}/${id}_${empreinte.slice(0, 8)}${thumb ? '_t' : ''}.webp`;
}

/**
 * Clé d'un sticker personnel : `stickers/u/<alanyaID>/<sel16>_<sha256>[_t].webp`.
 * `sel` (16 hex tirés au hasard à la création, ENREGISTRÉS dans `storage_key`)
 * ferme l'oracle d'existence : connaître l'empreinte d'une image ne suffit pas
 * à deviner l'adresse du fichier d'un autre compte.
 */
function personalStickerKey({ alanyaID, sha256, sel = crypto.randomBytes(8).toString('hex'), thumb = false }) {
  const compte = Number(alanyaID);
  const empreinte = String(sha256 || '').toLowerCase();
  if (!Number.isInteger(compte) || compte <= 0) throw new Error('alanyaID invalide');
  if (!/^[0-9a-f]{64}$/.test(empreinte)) throw new Error('empreinte de sticker invalide');
  if (!/^[0-9a-f]{16}$/.test(sel)) throw new Error('sel de sticker invalide');
  return `stickers/u/${compte}/${sel}_${empreinte}${thumb ? '_t' : ''}.webp`;
}

/**
 * Clé d'une sonnerie importée, choisie pour une liste :
 * `ringtones/<compte>/<jeton>`.
 *
 * Le jeton est un HMAC de l'empreinte SHA-256 du fichier sous un secret du
 * serveur (`RINGTONE_KEY_SECRET`). Stable : le même fichier n'est déposé
 * qu'une fois par compte, et son adresse se recalcule à partir de ce que la
 * liste enregistre déjà. Imprévisible : une clé tirée de l'empreinte seule
 * laisserait quiconque possède le même morceau vérifier qu'un compte donné
 * l'utilise. Sans secret, `null` : la fonctionnalité reste éteinte.
 */
function ringtoneKey({ alanyaID, sha256, secret = process.env.RINGTONE_KEY_SECRET }) {
  const empreinte = String(sha256 || '').toLowerCase();
  const compte = Number(alanyaID);
  if (!secret || !/^[0-9a-f]{64}$/.test(empreinte) || !(compte > 0)) return null;
  const jeton = crypto.createHmac('sha256', secret)
    .update(`ringtone:${compte}:${empreinte}`)
    .digest('hex')
    .slice(0, 40);
  return `ringtones/${compte}/${jeton}`;
}

/**
 * Adresse publique d'une clé : l'adresse Backblaze directe pour un fichier
 * public, l'adresse de ce serveur sinon (un média de discussion y est lu par
 * redirection vers un lien signé).
 */
function publicUrl(key) {
  const cible = cibleDe(key);
  if (cible.publique) return `${urlPubliqueDe(cible.bucket)}/${encoderCle(key)}`;
  return `${BASE_URL}/uploads/${key}`;
}

/** Adresse d'une sonnerie de liste, ou `null` si elle ne peut pas exister. */
function ringtoneUrl({ alanyaID, sha256 }) {
  if (!isB2Enabled()) return null;
  const key = ringtoneKey({ alanyaID, sha256 });
  return key ? publicUrl(key) : null;
}

const TYPES_PAR_EXTENSION = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};

/** Type MIME déduit de l'extension, pour un fichier repris du disque. */
const contentTypeForKey = (key) => TYPES_PAR_EXTENSION[safeExt(key)] || 'application/octet-stream';

// ── Liens signés ────────────────────────────────────────────────────────────

/**
 * Lien de lecture signé, pour la méthode de la requête d'origine : la méthode
 * fait partie de la signature, et un `HEAD` envoyé sur un lien signé pour
 * `GET` serait refusé. L'application envoie un `HEAD` avant ses
 * téléchargements automatiques.
 */
async function presignRead(key, method = 'GET') {
  const { GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const Commande = method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
  // Toujours un bucket privé : un fichier public se lit sans signature, et un
  // ancien fichier public pas encore copié y est encore.
  const nom = await lieuDeLecture(key);
  return getSignedUrl(
    clientConfigure(nom),
    new Commande({ Bucket: bucketDe(nom), Key: key }),
    { expiresIn: STORAGE.downloadTtlS },
  );
}

/**
 * Bucket privé où lire `key`. Pendant le départ de Backblaze, un média pas
 * encore copié n'est que dans l'ancien bucket : une requête à R2 le dit. Dans
 * le doute, R2 — c'est là que tout finit.
 */
async function lieuDeLecture(key) {
  if (!ancienActif()) return 'prive';
  try {
    return (await headObject(key, { depuis: 'prive' })) ? 'prive' : 'ancien';
  } catch {
    return 'prive';
  }
}

/**
 * Lien d'envoi direct (PUT) signé.
 *
 * Le type, la taille et l'en-tête de cache font partie de la signature : un
 * envoi qui ne correspond pas à ce que le serveur a autorisé est refusé par
 * le stockage lui-même. `headers` liste ce que le client doit envoyer à
 * l'identique (la taille, il la pose de lui-même).
 */
async function presignUpload(key, { contentType, contentLength }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cible = cibleDe(key);
  const url = await getSignedUrl(
    clientConfigure(cible.nom),
    new PutObjectCommand({
      Bucket: cible.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      CacheControl: CACHE_IMMUABLE,
    }),
    {
      expiresIn: STORAGE.uploadTtlS,
      // `cache-control` est exclu de la signature par défaut : il faut le
      // demander explicitement, sinon un client pourrait le réécrire.
      signableHeaders: new Set(['content-type', 'content-length', 'cache-control']),
    },
  );
  return {
    url,
    expiresIn: STORAGE.uploadTtlS,
    headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_IMMUABLE },
  };
}

// ── Opérations ──────────────────────────────────────────────────────────────

/** Dépose un fichier local sous `key` (découpé en parties au-delà de 8 Mo). */
async function putFile(key, cheminLocal, { contentType } = {}) {
  return putBody(key, fs.createReadStream(cheminLocal), { contentType });
}

/** Dépose un flux ou un tampon sous `key`, dans le bucket de sa clé. */
async function putBody(key, corps, { contentType } = {}) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const cible = cibleDe(key);
  const envoi = new Upload({
    client: clientEnvoi(cible.nom),
    params: {
      Bucket: cible.bucket,
      Key: key,
      Body: corps,
      ContentType: contentType || contentTypeForKey(key),
      CacheControl: CACHE_IMMUABLE,
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
    leavePartsOnError: false,
  });
  await envoi.done();
}

/**
 * Copie côté stockage : aucun octet ne passe par le serveur. Dans un même
 * bucket seulement — chaque clé d'application est limitée au sien.
 */
async function copyObject(cleSource, cleCible) {
  const { CopyObjectCommand } = require('@aws-sdk/client-s3');
  const cible = cibleDe(cleCible);
  if (cibleDe(cleSource).nom !== cible.nom) {
    throw new Error(`copie entre deux buckets impossible : ${cleSource} → ${cleCible}`);
  }
  await clientEnvoi(cible.nom).send(new CopyObjectCommand({
    Bucket: cible.bucket,
    Key: cleCible,
    CopySource: `${cible.bucket}/${encoderCle(cleSource)}`,
  }));
}

/**
 * `true` si la clé existe dans son bucket (ou dans le bucket `depuis` : `prive`
 * pour un fichier public pas encore copié).
 */
async function headObject(key, { depuis } = {}) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  const nom = depuis || cibleDe(key).nom;
  try {
    await clientEnvoi(nom).send(new HeadObjectCommand({ Bucket: bucketDe(nom), Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false;
    throw e;
  }
}

/**
 * Contenu d'une clé du bucket privé, ou de l'ancien (`depuis: 'ancien'`) :
 * `{ Body, ContentType }` (migrations).
 */
async function readPrivateObject(key, { depuis = 'prive' } = {}) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  return clientEnvoi(depuis).send(new GetObjectCommand({ Bucket: bucketDe(depuis), Key: key }));
}

/**
 * Supprime une clé pour de bon, **toutes versions comprises**. Renvoie le
 * nombre de suppressions faites.
 *
 * Chez Backblaze, une suppression simple ne fait que masquer le fichier : il
 * reste stocké, et récupérable, jusqu'au passage quotidien des règles de cycle
 * de vie. Pour un média à vue unique consommé, ce n'est pas acceptable. Les
 * versions sont supprimées une à une : il n'y en a qu'une ou deux, et
 * `DeleteObjects` exigerait une somme de contrôle que tous les services
 * compatibles S3 ne calculent pas de la même façon. R2 ne garde aucune
 * version : une suppression y est immédiate et définitive.
 */
async function removeAllVersions(key, { seulement } = {}) {
  const cible = cibleDe(key);
  let lieux;
  if (seulement === 'prive') {
    // Le nettoyage qui suit la copie vers un bucket public ne doit pas
    // toucher à la copie.
    lieux = ['prive'];
  } else if (cible.publique) {
    // Un fichier public a pu naître dans le bucket privé de Backblaze, avant
    // la répartition : il est cherché aux deux endroits. Le bucket R2, plus
    // récent, n'en a jamais reçu.
    lieux = r2Configure() ? [cible.nom] : [cible.nom, 'prive'];
  } else {
    // Pendant le départ de Backblaze, un média privé peut exister des deux
    // côtés : une vue unique consommée ne doit survivre dans aucun.
    lieux = ancienActif() ? ['prive', 'ancien'] : ['prive'];
  }
  let total = 0;
  for (const nom of lieux) {
    // eslint-disable-next-line no-await-in-loop
    total += await supprimerDans(nom, key);
  }
  return total;
}

/** Supprime `key` du bucket `nom` ; renvoie le nombre de suppressions faites. */
async function supprimerDans(nom, key) {
  const { ListObjectVersionsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const { bucket, versions } = reglagesDe(nom);
  if (!versions) {
    await clientEnvoi(nom).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return 1;
  }
  const res = await clientEnvoi(nom).send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  const trouvees = [...(res.Versions || []), ...(res.DeleteMarkers || [])]
    .filter((v) => v.Key === key);
  for (const v of trouvees) {
    // eslint-disable-next-line no-await-in-loop
    await clientEnvoi(nom).send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: v.VersionId,
    }));
  }
  return trouvees.length;
}

/**
 * Objets sous un préfixe : `[{ key, size, lastModified }]`, toutes pages
 * confondues. Dans le bucket du préfixe, ou dans le bucket `depuis`.
 */
async function listPrefix(prefixe, { depuis } = {}) {
  const nom = depuis || cibleDe(prefixe).nom;
  const objets = await listerDans(nom, prefixe);
  if (depuis || nom !== 'prive' || !ancienActif()) return objets;
  // Pendant le départ de Backblaze, un média privé peut n'être encore que
  // dans l'ancien bucket.
  const connus = new Set(objets.map((o) => o.key));
  for (const o of await listerDans('ancien', prefixe)) {
    if (!connus.has(o.key)) objets.push(o);
  }
  return objets;
}

async function listerDans(nom, prefixe) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const bucket = bucketDe(nom);
  const out = [];
  let jeton;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await clientEnvoi(nom).send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefixe,
      ContinuationToken: jeton,
    }));
    for (const o of res.Contents || []) {
      out.push({
        key: o.Key,
        size: Number(o.Size) || 0,
        lastModified: o.LastModified ? new Date(o.LastModified).getTime() : 0,
      });
    }
    jeton = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (jeton);
  return out;
}

/**
 * Copie propre d'un média transféré, dans la partition du jour, côté
 * stockage : aucun octet ne passe par le serveur.
 *
 * Chaque message garantit ainsi la rétention à son propre média : sans copie,
 * le transfert mourrait avec le média d'origine. Renvoie la nouvelle clé, ou
 * `null` — l'appelant garde alors l'URL d'origine.
 */
async function copyForForward(mediaUrl, { alanyaID, instant = Date.now() } = {}) {
  const source = storedKeyFromUrl(mediaUrl);
  if (!source || !source.startsWith(`${MEDIA_ROOT}/`)) return null;
  const segments = source.split('/');
  const kind = segments[segments.length - 2];
  if (!LEGACY_KINDS.includes(kind)) return null;

  const cible = newMediaKey({ kind, alanyaID, ext: safeExt(source), instant });
  try {
    await copyObject(source, cible);
    return cible;
  } catch (e) {
    console.error('[MediaStorage] transfert : copie impossible:', e.message);
    return null;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

/**
 * État du départ de Backblaze, pour le script de copie : `r2` (le bucket privé
 * est chez R2), `ancien` (le bucket privé de Backblaze est joignable),
 * `terminee` (`MEDIA_PRIVATE_MIGRATED` est posé).
 */
const etatMigrationPrivee = () => ({
  r2: r2Configure(),
  ancien: b2PriveConfigure(),
  terminee: STORAGE.privateMigrated,
});

/**
 * Réglages de test : configuration, et faux client pour les requêtes réseau.
 * R2 et la fin de migration sont remis à zéro à chaque appel : le `.env` de
 * développement, que certains tests chargent, ne doit pas décider à leur place.
 */
function configureForTests({ client, publics, r2, privateMigrated = false, ...reglages } = {}) {
  Object.assign(STORAGE, reglages, { privateMigrated });
  Object.assign(STORAGE.r2, { endpoint: '', bucket: '', keyId: '', appKey: '' }, r2);
  if (publics) {
    for (const [nom, conf] of Object.entries(publics)) Object.assign(STORAGE.publics[nom], conf);
  }
  clientsReels.clear();
  clientDeTest = client || null;
}

module.exports = {
  STORAGE,
  CACHE_IMMUABLE,
  isB2Enabled,
  isSafeKey,
  keyFromPath,
  keyFromUrl,
  storedKeyFromUrl,
  safeExt,
  newMediaKey,
  newImageKey,
  newVoicemailGreetingKey,
  newOfficialKey,
  officialStickerKey,
  personalStickerKey,
  ringtoneKey,
  ringtoneUrl,
  cibleDe,
  etatMigrationPrivee,
  publicUrl,
  contentTypeForKey,
  presignRead,
  presignUpload,
  putFile,
  putBody,
  copyObject,
  headObject,
  readPrivateObject,
  removeAllVersions,
  listPrefix,
  copyForForward,
  configureForTests,
};
