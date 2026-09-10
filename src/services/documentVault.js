/**
 * Coffre à pièces d'identité.
 *
 * Trois exigences (volet 5, « Sécurité des pièces ») :
 * - chiffrées au repos, fichier par fichier, sous une clé qui n'est pas en
 *   base (VAULT_KEY, 32 octets en base64) ;
 * - jamais servies en statique : le coffre (VAULT_DIR, chemin absolu) vit
 *   hors de uploads/, que server.js expose — il est refusé s'il s'y trouve ;
 * - lues seulement par la route d'administration authentifiée, qui journalise
 *   chaque ouverture.
 *
 * Format d'un fichier : « AV1 » (3 octets) · IV (12) · tag GCM (16) · chiffré.
 * AES-256-GCM : un fichier altéré ou chiffré sous une autre clé est refusé,
 * pas déchiffré en bouillie.
 *
 * ⚠ Changer VAULT_KEY rend illisibles toutes les pièces déjà déposées. Elles
 * sont détruites 90 jours après la décision : attendre ce délai, ou redemander
 * les pièces des dossiers ouverts.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const MAGIC = Buffer.from('AV1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + IV_BYTES + TAG_BYTES;
const STORAGE_KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.bin$/;
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

/** La clé, ou null si absente. Lève si elle est posée mais invalide. */
function vaultKey(env = process.env) {
  const raw = env.VAULT_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('VAULT_KEY doit faire 32 octets en base64 (openssl rand -base64 32)');
  }
  return key;
}

/** Le dossier, s'il est absolu et hors de ce qui est servi en statique. */
function vaultDir(env = process.env) {
  const dir = env.VAULT_DIR;
  if (!dir || !path.isAbsolute(dir)) return null;
  const resolved = path.resolve(dir);
  if (resolved === UPLOADS_DIR || resolved.startsWith(UPLOADS_DIR + path.sep)) return null;
  return resolved;
}

/** Faux tant que le coffre n'est pas configuré : le dépôt répond 503. */
function vaultConfigured(env = process.env) {
  try {
    return Boolean(vaultKey(env) && vaultDir(env));
  } catch {
    return false;
  }
}

function seal(plain, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function open(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Pièce illisible : format inconnu');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = blob.subarray(MAGIC.length + IV_BYTES, HEADER);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(HEADER)), decipher.final()]);
}

function isStorageKey(value) {
  return typeof value === 'string' && STORAGE_KEY_RE.test(value);
}

function requireVault(env) {
  const key = vaultKey(env);
  const dir = vaultDir(env);
  if (!key || !dir) throw new Error('Coffre à pièces non configuré (VAULT_KEY, VAULT_DIR)');
  return { key, dir };
}

function resolveKey(dir, storageKey) {
  if (!isStorageKey(storageKey)) throw new Error('Clé de stockage invalide');
  return path.join(dir, storageKey);
}

/**
 * Chiffre et range une pièce.
 * @returns {Promise<{ storageKey: string, sha256: string, size: number }>}
 */
async function storeDocument(buffer, { env = process.env, now = new Date() } = {}) {
  const { key, dir } = requireVault(env);
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const storageKey = `${yyyy}/${mm}/${crypto.randomUUID()}.bin`;
  const file = resolveKey(dir, storageKey);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, seal(buffer, key), { mode: 0o600, flag: 'wx' });
  return {
    storageKey,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
  };
}

/** Déchiffre une pièce, en mémoire seulement. */
async function readDocument(storageKey, { env = process.env } = {}) {
  const { key, dir } = requireVault(env);
  return open(await fs.readFile(resolveKey(dir, storageKey)), key);
}

/** Détruit une pièce. Déjà absente : rien à faire. */
async function destroyDocument(storageKey, { env = process.env } = {}) {
  const { dir } = requireVault(env);
  try {
    await fs.unlink(resolveKey(dir, storageKey));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  vaultKey,
  vaultDir,
  vaultConfigured,
  seal,
  open,
  isStorageKey,
  storeDocument,
  readDocument,
  destroyDocument,
};
