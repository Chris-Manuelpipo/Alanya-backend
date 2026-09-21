/**
 * Stockage des médias — Backblaze B2, par son API compatible S3.
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
 * ── Le disque n'est plus une option ──
 *
 * Il n'y a plus d'interrupteur : tout média passe par ce module. Une
 * configuration incomplète est donc une panne, annoncée au démarrage et rendue
 * en `503 STORAGE_UNAVAILABLE` aux appelants — jamais un repli silencieux sur
 * un disque que plus personne ne relit.
 *
 * ── La purge n'est pas ici ──
 *
 * Les règles de cycle de vie du bucket suppriment les médias échus. Ce module
 * ne supprime que sur demande explicite : un média à vue unique consommé, dont
 * toutes les versions doivent disparaître tout de suite.
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

/** Préfixes servis par `/uploads`. `exports/` et le reste ne le sont jamais. */
const PREFIXES_SERVIS = [MEDIA_ROOT, 'images'];

const SEGMENT_SUR = /^[A-Za-z0-9._-]+$/;
const EXTENSION_SURE = /^\.[a-z0-9]{1,8}$/;

const lireEntier = (nom, defaut, min, max) => {
  const n = Number.parseInt(process.env[nom], 10);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, n));
};

const STORAGE = {
  endpoint: process.env.B2_ENDPOINT || '',
  region: process.env.B2_REGION || '',
  bucket: process.env.B2_BUCKET || '',
  keyId: process.env.B2_KEY_ID || '',
  appKey: process.env.B2_APP_KEY || '',
  downloadTtlS: lireEntier('B2_DOWNLOAD_URL_TTL_S', 3600, 60, 86400),
  uploadTtlS: lireEntier('B2_UPLOAD_URL_TTL_S', 900, 60, 3600),
};

/** `true` si les cinq variables indispensables sont renseignées. */
const isConfigured = () =>
  Boolean(STORAGE.endpoint && STORAGE.region && STORAGE.bucket && STORAGE.keyId && STORAGE.appKey);

if (!isConfigured() && process.env.NODE_ENV !== 'test') {
  // Bruyant exprès : sans repli disque, une configuration incomplète veut dire
  // qu'aucun média ne pourra être déposé ni servi. Mieux vaut le lire au
  // démarrage que le découvrir au premier envoi d'un utilisateur.
  console.error('[MediaStorage] B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID ou B2_APP_KEY '
    + 'manque : aucun média ne pourra être déposé ni servi.');
}

// ── Clients ─────────────────────────────────────────────────────────────────

let clientReel = null;
let clientDeTest = null;

/** Client configuré : sert à signer (calcul local, sans réseau) et à envoyer. */
function clientConfigure() {
  if (!clientReel) {
    const { S3Client } = require('@aws-sdk/client-s3');
    clientReel = new S3Client({
      endpoint: STORAGE.endpoint,
      region: STORAGE.region,
      credentials: { accessKeyId: STORAGE.keyId, secretAccessKey: STORAGE.appKey },
      // Les versions récentes du SDK ajoutent d'office des sommes de contrôle
      // CRC32 que des services compatibles S3 refusent. On s'en tient à celles
      // que l'API exige.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return clientReel;
}

/** Client des requêtes réseau ; remplacé par un faux dans les tests. */
const clientEnvoi = () => clientDeTest || clientConfigure();

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

/** Clé d'une URL publique (`…/uploads/<clé>`), ou `null`. */
function keyFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const marqueur = '/uploads/';
  const i = s.indexOf(marqueur);
  if (i === -1) return null;
  return keyFromPath(s.slice(i + marqueur.length).split(/[?#]/)[0]);
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

/** Adresse publique d'une clé. */
const publicUrl = (key) => `${BASE_URL}/uploads/${key}`;

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
  return getSignedUrl(
    clientConfigure(),
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
  const url = await getSignedUrl(
    clientConfigure(),
    new PutObjectCommand({
      Bucket: STORAGE.bucket,
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
  const { Upload } = require('@aws-sdk/lib-storage');
  const envoi = new Upload({
    client: clientEnvoi(),
    params: {
      Bucket: STORAGE.bucket,
      Key: key,
      Body: fs.createReadStream(cheminLocal),
      ContentType: contentType || contentTypeForKey(key),
      CacheControl: CACHE_IMMUABLE,
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
    leavePartsOnError: false,
  });
  await envoi.done();
}

/** Copie côté Backblaze : aucun octet ne passe par le serveur. */
async function copyObject(cleSource, cleCible) {
  const { CopyObjectCommand } = require('@aws-sdk/client-s3');
  const source = cleSource.split('/').map(encodeURIComponent).join('/');
  await clientEnvoi().send(new CopyObjectCommand({
    Bucket: STORAGE.bucket,
    Key: cleCible,
    CopySource: `${STORAGE.bucket}/${source}`,
  }));
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
async function removeAllVersions(key) {
  const { ListObjectVersionsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const res = await clientEnvoi().send(new ListObjectVersionsCommand({
    Bucket: STORAGE.bucket,
    Prefix: key,
  }));
  const versions = [...(res.Versions || []), ...(res.DeleteMarkers || [])]
    .filter((v) => v.Key === key);
  for (const v of versions) {
    // eslint-disable-next-line no-await-in-loop
    await clientEnvoi().send(new DeleteObjectCommand({
      Bucket: STORAGE.bucket,
      Key: key,
      VersionId: v.VersionId,
    }));
  }
  return versions.length;
}

/** Objets sous un préfixe : `[{ key, size }]`, toutes pages confondues. */
async function listPrefix(prefixe) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const out = [];
  let jeton;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await clientEnvoi().send(new ListObjectsV2Command({
      Bucket: STORAGE.bucket,
      Prefix: prefixe,
      ContinuationToken: jeton,
    }));
    for (const o of res.Contents || []) out.push({ key: o.Key, size: Number(o.Size) || 0 });
    jeton = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (jeton);
  return out;
}

/**
 * Copie propre d'un média transféré, dans la partition du jour.
 *
 * Chaque message garantit la rétention à son propre média : sans cette copie,
 * deux messages partageraient une clé, et la chute de la partition du plus
 * ancien laisserait le transfert pointer dans le vide. La copie a lieu chez
 * Backblaze, aucun octet ne passe par le serveur. Renvoie la nouvelle clé, ou
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

/** Réglages de test : configuration, et faux client pour les requêtes réseau. */
function configureForTests({ client, ...reglages } = {}) {
  Object.assign(STORAGE, reglages);
  clientReel = null;
  clientDeTest = client || null;
}

module.exports = {
  STORAGE,
  CACHE_IMMUABLE,
  isConfigured,
  isSafeKey,
  keyFromPath,
  keyFromUrl,
  storedKeyFromUrl,
  safeExt,
  newMediaKey,
  newImageKey,
  publicUrl,
  contentTypeForKey,
  presignRead,
  presignUpload,
  putFile,
  copyObject,
  removeAllVersions,
  listPrefix,
  copyForForward,
  configureForTests,
};
