/**
 * Stockage objet des médias — Backblaze B2, par son API compatible S3.
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
 * ── L'interrupteur ──
 *
 * `MEDIA_STORAGE=b2` active le stockage objet ; toute autre valeur, ou une
 * configuration incomplète, laisse le disque. Déployer ce code sans rien
 * poser dans le `.env` ne change donc aucun comportement — même principe que
 * `MEDIA_PARTITIONS_ENABLED`.
 *
 * ── Trois buckets ──
 *
 * Conception : docs/conception/medias-buckets.html. Le préfixe de la clé
 * décide du bucket, sans rien demander au client :
 *  - `media/` : `B2_BUCKET` (alanyaprivate), privé, lu par lien signé ;
 *  - `images/` : `B2_PROFILE_BUCKET` (alanyaprofile), public ;
 *  - `voicemail/`, `ringtones/`, `official/` : `B2_PROFILEMEDIA_BUCKET`
 *    (profilemedia), public.
 * Un fichier public est lu par son adresse Backblaze directe, sans passer par
 * ce serveur. Tant qu'un bucket public n'est pas configuré (nom et clé), ses
 * préfixes restent dans le bucket privé, comme avant.
 *
 * ── La purge n'est pas ici ──
 *
 * Elle est décidée par `mediaRetention.js`, message par message : 30 jours, ou
 * 365 pour un média qu'un abonné Alanya Plus peut encore demander. Backblaze
 * n'applique qu'une durée par préfixe ; ses règles de cycle de vie ne sont
 * qu'un filet (`media/` masqué à 366 jours). Ce module ne supprime que sur
 * demande, et toujours toutes les versions : média échu, vue unique
 * consommée, photo ou annonce remplacée.
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
const { UPLOADS_DIR } = require('./mediaPartitions');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Cache des octets servis : un nom de fichier n'est jamais réutilisé, donc
 * l'appareil peut garder un média indéfiniment — la règle « borner le
 * serveur, jamais l'appareil ».
 */
const CACHE_IMMUABLE = 'public, max-age=31536000, immutable';

/** Préfixes servis par `/uploads`. `exports/` et le reste ne le sont jamais. */
/**
 * `voicemail` : les annonces de répondeur.
 *
 * Elles ont leur propre préfixe, et pas par coquetterie — deux purges
 * l'imposent. `mediaRetention` ne voit que ce que `message.mediaUrl` désigne,
 * et une annonce n'est jamais un message ; mais surtout `sweepPartitions`
 * SUPPRIME le répertoire daté entier sous `uploads/media/`, sans consulter
 * aucune table. Une annonce rangée là disparaîtrait toute seule, à terme, sans
 * que rien ne l'explique.
 *
 * ⚠ Oublier ce préfixe ici casse le service en mode B2 — `isSafeKey` refuse la
 * clé — et silencieusement, puisque B2 est éteint par défaut : personne ne le
 * verrait avant de l'allumer.
 */
const PREFIXES_SERVIS = [MEDIA_ROOT, 'images', 'voicemail', 'ringtones', 'official'];

/** Bucket public de chaque préfixe public. Tout le reste va dans le bucket privé. */
const BUCKET_PUBLIC_DU_PREFIXE = {
  images: 'profile',
  voicemail: 'profilemedia',
  ringtones: 'profilemedia',
  official: 'profilemedia',
};

const SEGMENT_SUR = /^[A-Za-z0-9._-]+$/;
const EXTENSION_SURE = /^\.[a-z0-9]{1,8}$/;

const lireEntier = (nom, defaut, min, max) => {
  const n = Number.parseInt(process.env[nom], 10);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, n));
};

const STORAGE = {
  demande: String(process.env.MEDIA_STORAGE || 'disk').trim().toLowerCase(),
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
  publicMigrated: ['1', 'true', 'oui', 'yes', 'on']
    .includes(String(process.env.MEDIA_PUBLIC_MIGRATED || '').trim().toLowerCase()),
};

const configurationComplete = () =>
  Boolean(STORAGE.endpoint && STORAGE.region && STORAGE.bucket && STORAGE.keyId && STORAGE.appKey);

if (STORAGE.demande === 'b2' && !configurationComplete()) {
  // Bruyant exprès : un interrupteur allumé sur une configuration incomplète
  // resterait sinon silencieusement sur le disque.
  console.error('[MediaStorage] MEDIA_STORAGE=b2 mais B2_ENDPOINT, B2_REGION, B2_BUCKET, '
    + 'B2_KEY_ID ou B2_APP_KEY manque : les médias restent sur le disque.');
}

// Même principe pour un bucket public : à moitié configuré, ses fichiers
// resteraient dans le bucket privé sans que rien ne le dise.
for (const [nom, conf] of Object.entries(STORAGE.publics)) {
  const poses = [conf.bucket, conf.keyId, conf.appKey].filter(Boolean).length;
  if (STORAGE.demande === 'b2' && poses > 0 && poses < 3) {
    console.error(`[MediaStorage] bucket public « ${nom} » incomplet (nom, clé et secret requis) : `
      + 'ses fichiers restent dans le bucket privé.');
  }
}

/** `true` si les médias vont chez Backblaze. */
const isB2Enabled = () => STORAGE.demande === 'b2' && configurationComplete();

// ── Clients ─────────────────────────────────────────────────────────────────

const clientsReels = new Map();
let clientDeTest = null;

/** Identifiants du bucket `nom` : `prive`, ou un bucket public. */
const identifiantsDe = (nom) => (nom === 'prive'
  ? { keyId: STORAGE.keyId, appKey: STORAGE.appKey }
  : STORAGE.publics[nom]);

/** Client configuré : sert à signer (calcul local, sans réseau) et à envoyer. */
function clientConfigure(nom = 'prive') {
  if (!clientsReels.has(nom)) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { keyId, appKey } = identifiantsDe(nom);
    clientsReels.set(nom, new S3Client({
      endpoint: STORAGE.endpoint,
      region: STORAGE.region,
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

/** `true` si le bucket public `nom` a un nom et une clé. */
const publicConfigure = (nom) => {
  const c = STORAGE.publics[nom];
  return Boolean(c && c.bucket && c.keyId && c.appKey);
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
  return { nom: 'prive', bucket: STORAGE.bucket, publique: false };
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

/** Chemin sur le disque d'une clé déjà validée. */
const diskPathForKey = (key, root = UPLOADS_DIR) => path.join(root, key);

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
  // Toujours le bucket privé : un fichier public se lit sans signature, et un
  // ancien fichier public pas encore copié y est encore.
  return getSignedUrl(
    clientConfigure('prive'),
    new Commande({ Bucket: STORAGE.bucket, Key: key }),
    { expiresIn: STORAGE.downloadTtlS },
  );
}

/**
 * Lien d'envoi direct (PUT) signé.
 *
 * Le type, la taille et l'en-tête de cache font partie de la signature : un
 * envoi qui ne correspond pas à ce que le serveur a autorisé est refusé par
 * Backblaze lui-même. `headers` liste ce que le client doit envoyer à
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
 * Copie côté Backblaze : aucun octet ne passe par le serveur. Dans un même
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
  const bucket = nom === 'prive' ? STORAGE.bucket : STORAGE.publics[nom].bucket;
  try {
    await clientEnvoi(nom).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false;
    throw e;
  }
}

/** Contenu d'une clé du bucket privé : `{ Body, ContentType }` (migration). */
async function readPrivateObject(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  return clientEnvoi('prive').send(new GetObjectCommand({ Bucket: STORAGE.bucket, Key: key }));
}

/**
 * Supprime **toutes les versions** d'une clé.
 *
 * Une suppression simple ne fait que masquer le fichier : il reste stocké, et
 * récupérable, jusqu'au passage quotidien des règles de cycle de vie. Pour un
 * média à vue unique consommé, ce n'est pas acceptable. Les versions sont
 * supprimées une à une : il n'y en a qu'une ou deux, et `DeleteObjects`
 * exigerait une somme de contrôle que tous les services compatibles S3 ne
 * calculent pas de la même façon.
 */
async function removeAllVersions(key, { seulement } = {}) {
  const { ListObjectVersionsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  // Un fichier public a pu naître dans le bucket privé, avant la répartition :
  // il est cherché aux deux endroits. `seulement: 'prive'` ne vise que le
  // privé — le nettoyage qui suit la copie ne doit pas toucher à la copie.
  const cible = cibleDe(key);
  const prive = { nom: 'prive', bucket: STORAGE.bucket };
  let lieux = cible.publique ? [cible, prive] : [cible];
  if (seulement === 'prive') lieux = [prive];
  let total = 0;
  for (const lieu of lieux) {
    // eslint-disable-next-line no-await-in-loop
    const res = await clientEnvoi(lieu.nom).send(new ListObjectVersionsCommand({
      Bucket: lieu.bucket,
      Prefix: key,
    }));
    const versions = [...(res.Versions || []), ...(res.DeleteMarkers || [])]
      .filter((v) => v.Key === key);
    for (const v of versions) {
      // eslint-disable-next-line no-await-in-loop
      await clientEnvoi(lieu.nom).send(new DeleteObjectCommand({
        Bucket: lieu.bucket,
        Key: key,
        VersionId: v.VersionId,
      }));
    }
    total += versions.length;
  }
  return total;
}

/**
 * Objets sous un préfixe : `[{ key, size, lastModified }]`, toutes pages
 * confondues. Dans le bucket du préfixe, ou dans le bucket `depuis`.
 */
async function listPrefix(prefixe, { depuis } = {}) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const nom = depuis || cibleDe(prefixe).nom;
  const bucket = nom === 'prive' ? STORAGE.bucket : STORAGE.publics[nom].bucket;
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
 * Copie propre d'un média transféré, dans la partition du jour.
 *
 * Même sémantique que l'ancien lien matériel (`relinkForForward`) : chaque
 * message garantit la rétention à son propre média. Pendant la transition, un
 * fichier encore sur le disque est déposé depuis le disque. Renvoie la
 * nouvelle clé, ou `null` — l'appelant garde alors l'URL d'origine.
 */
async function copyForForward(mediaUrl, { alanyaID, instant = Date.now(), root = UPLOADS_DIR } = {}) {
  const source = storedKeyFromUrl(mediaUrl);
  if (!source || !source.startsWith(`${MEDIA_ROOT}/`)) return null;
  const segments = source.split('/');
  const kind = segments[segments.length - 2];
  if (!LEGACY_KINDS.includes(kind)) return null;

  const cible = newMediaKey({ kind, alanyaID, ext: safeExt(source), instant });
  try {
    const surDisque = diskPathForKey(source, root);
    if (fs.existsSync(surDisque)) {
      await putFile(cible, surDisque, { contentType: contentTypeForKey(source) });
    } else {
      await copyObject(source, cible);
    }
    return cible;
  } catch (e) {
    console.error('[MediaStorage] transfert : copie impossible:', e.message);
    return null;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

/** Réglages de test : configuration, et faux client pour les requêtes réseau. */
function configureForTests({ client, publics, ...reglages } = {}) {
  Object.assign(STORAGE, reglages);
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
  ringtoneKey,
  ringtoneUrl,
  cibleDe,
  publicUrl,
  diskPathForKey,
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
