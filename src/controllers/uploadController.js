const fs = require('fs');
const path = require('path');

const pool = require('../config/db');
const storage = require('../services/mediaStorage');
const {
  mediaSubDir,
  IMAGE_MIME_TYPES,
  MEDIA_MIME_TYPES,
  AVATAR_MAX_BYTES,
  MEDIA_MAX_BYTES,
  RINGTONE_MIME_TYPES,
  RINGTONE_MAX_BYTES,
} = require('../middleware/upload');
const { entitlementsOrNull } = require('../services/billing/entitlements');
const { limitsFor } = require('../services/billing/uploadLimits');
const { FEATURE } = require('../constants/billing');
const { invalidateSenderIdentity } = require('../utils/senderIdentityCache');
const { releasePublicFiles } = require('../utils/mediaFile');
const { fail } = require('../utils/apiError');

const _toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Type de message d'après le type MIME : 1=image, 2=vidéo, 3=audio, 4=fichier. */
const msgTypeFor = (mimetype = '') => {
  if (mimetype.startsWith('image/')) return 1;
  if (mimetype.startsWith('video/')) return 2;
  if (mimetype.startsWith('audio/')) return 3;
  return 4;
};

/**
 * Dépose chez Backblaze le fichier que multer a écrit en transit, sous la clé
 * décidée à l'ouverture du flux. Le fichier de transit ne survit jamais à la
 * requête, qu'elle réussisse ou non. Lève si Backblaze n'est pas configuré.
 */
async function deposerChezB2(file) {
  try {
    if (!storage.isB2Enabled()) throw new Error('Backblaze non configuré');
    await storage.putFile(file.storageKey, file.path, { contentType: file.mimetype });
    return storage.publicUrl(file.storageKey);
  } finally {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

const stockageIndisponible = (res) =>
  fail(res, 503, 'STORAGE_UNAVAILABLE', 'Stockage des médias indisponible');

// Héberge une image (avatar profil, photo de groupe, etc.) et retourne son URL.
// Par défaut ne modifie aucune entité en base ; avec applyToProfile=true, met
// à jour avatar_url de l'utilisateur connecté en une seule requête.
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'FILE_REQUIRED' });
    }

    const filename = req.file.filename;
    let url;
    try {
      url = await deposerChezB2(req.file);
    } catch (e) {
      console.error('[Upload avatar] dépôt Backblaze échoué:', e.message);
      return stockageIndisponible(res);
    }
    const applyToProfile = _toBool(req.body?.applyToProfile ?? req.query?.applyToProfile);

    if (applyToProfile) {
      if (!req.user?.alanyaID) {
        return res.status(401).json({ error: 'Authentification requise pour applyToProfile', code: 'MEDIA_REQUIRED' });
      }
      const [avant] = await pool.execute(
        'SELECT avatar_url FROM users WHERE alanyaID = ?',
        [req.user.alanyaID],
      );
      await pool.execute(
        'UPDATE users SET avatar_url = ? WHERE alanyaID = ?',
        [url, req.user.alanyaID],
      );
      // Le payload temps réel des messages sert l'avatar depuis un cache 60 s.
      invalidateSenderIdentity(req.user.alanyaID);
      // L'ancienne photo n'est plus désignée : elle est supprimée, sauf si une
      // autre ligne la désigne encore ou si c'est un avatar par défaut.
      releasePublicFiles(avant[0]?.avatar_url);
    }

    res.json({
      url,
      filename,
      ...(applyToProfile ? { appliedToProfile: true } : {}),
    });
  } catch (error) {
    console.error('[Upload avatar] ERROR:', error);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

// Upload média message (image, audio, vidéo, fichier) 
const uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'FILE_REQUIRED' });
    }

    const file     = req.file;
    const filename = file.filename;
    const mimetype = file.mimetype;

    // Plafond du palier du compte (posé par enforceMediaTier avant multer) :
    // relu contre la taille RÉELLE, qu'un `Content-Length` absent ou menteur
    // n'a pas arrêtée. Les médias officiels n'en posent pas : le plafond
    // standard, celui de leur multer, leur suffit.
    const maxBytes = req.mediaMaxBytes ?? MEDIA_MAX_BYTES;
    if (file.size > maxBytes) {
      await fs.promises.unlink(file.path).catch(() => {});
      return fail(res, 413, 'FILE_TOO_LARGE', 'Fichier trop volumineux', { maxBytes });
    }

    // La clé, partition du jour comprise, a été décidée par multer à
    // l'ouverture du flux (`file.storageKey`) : elle est relue, jamais
    // recalculée, sans quoi un envoi commencé à 23:59:59 recevrait l'adresse
    // du lendemain.
    let url;
    try {
      url = await deposerChezB2(file);
    } catch (e) {
      console.error('[Upload media] dépôt Backblaze échoué:', e.message);
      return stockageIndisponible(res);
    }

    res.json({
      url,
      filename,
      originalName: file.originalname,
      mimetype,
      size: file.size,
      msgType: msgTypeFor(mimetype),
    });
  } catch (error) {
    console.error('[Upload media] ERROR:', error);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

/**
 * `POST /api/upload/ticket` — autorise un envoi direct vers Backblaze.
 *
 * L'application annonce le type et la taille du fichier ; le serveur applique
 * les mêmes règles que l'envoi par formulaire (types acceptés, plafonds), fixe
 * la clé, puis signe un lien d'envoi `PUT`. Le fichier part ensuite du
 * téléphone directement chez Backblaze : un seul trajet, sans passer par ce
 * serveur. Le type et la taille font partie de la signature — un fichier qui
 * ne correspond pas à ce qui a été autorisé est refusé par Backblaze.
 *
 * Sans Backblaze configuré : 503 `STORAGE_UNAVAILABLE`, comme tout envoi.
 */
const uploadTicket = async (req, res) => {
  const { kind = 'media', mimetype, size, fileName } = req.body || {};
  if (kind === 'ringtone') return ticketSonnerie(req, res);
  if (kind !== 'media' && kind !== 'avatar') {
    return fail(res, 400, 'VALIDATION_FAILED', 'kind doit valoir media, avatar ou ringtone');
  }
  const avatar = kind === 'avatar';

  const type = String(mimetype || '').toLowerCase();
  if (!(avatar ? IMAGE_MIME_TYPES : MEDIA_MIME_TYPES).includes(type)) {
    return fail(res, 400, 'INVALID_EXTENSION', 'Type de fichier non autorisé');
  }
  const octets = Number(size);
  if (!Number.isInteger(octets) || octets <= 0) {
    return fail(res, 400, 'VALIDATION_FAILED', 'Taille de fichier invalide');
  }
  // Une photo de profil a son plafond ; un média, celui du palier du compte
  // (50 Mo, 200 Mo pour qui a payé — voir uploadLimits.js).
  const maxBytes = avatar ? AVATAR_MAX_BYTES : (await limitsFor(req.user.alanyaID)).maxUploadBytes;
  if (octets > maxBytes) {
    return fail(res, 413, 'FILE_TOO_LARGE', 'Fichier trop volumineux', { maxBytes });
  }

  if (!storage.isB2Enabled()) return stockageIndisponible(res);

  const ext = storage.safeExt(fileName);
  const key = avatar
    ? storage.newImageKey({ alanyaID: req.user.alanyaID, ext })
    : storage.newMediaKey({ kind: mediaSubDir(type), alanyaID: req.user.alanyaID, ext });

  try {
    const envoi = await storage.presignUpload(key, { contentType: type, contentLength: octets });
    return res.json({
      mode: 'direct',
      method: 'PUT',
      uploadUrl: envoi.url,
      headers: envoi.headers,
      expiresIn: envoi.expiresIn,
      url: storage.publicUrl(key),
      filename: path.basename(key),
      mimetype: type,
      size: octets,
      msgType: avatar ? 1 : msgTypeFor(type),
    });
  } catch (e) {
    console.error('[Upload ticket] signature impossible:', e.message);
    return stockageIndisponible(res);
  }
};

/**
 * Ticket `ringtone` : dépôt d'une sonnerie importée, choisie pour une liste.
 *
 * L'application annonce l'empreinte SHA-256 du fichier (celle que la liste
 * enregistre déjà), son type et sa taille. Trois réponses :
 *  - `exists` : le fichier est déjà là, rien à envoyer ;
 *  - `direct` : lien d'envoi `PUT` signé, comme pour un média ;
 *  - `unavailable` : stockage objet éteint, ou secret des sonneries absent.
 *    Rien n'est perdu : la sonnerie reste sur le téléphone, comme avant.
 * Dans les trois cas, `url` (quand elle existe) est l'adresse que les autres
 * appareils recevront avec les réglages de la liste.
 */
async function ticketSonnerie(req, res) {
  const { sha256, mimetype, size } = req.body || {};
  const alanyaID = req.user.alanyaID;

  const entitlements = await entitlementsOrNull(alanyaID);
  if (entitlements && entitlements.features[FEATURE.LIST_RINGTONES] === false) {
    return fail(res, 403, 'SUBSCRIPTION_REQUIRED', 'Fonctionnalité réservée à Alanya Plus', {
      feature: FEATURE.LIST_RINGTONES,
    });
  }

  const empreinte = String(sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(empreinte)) {
    return fail(res, 400, 'VALIDATION_FAILED', 'Empreinte SHA-256 invalide');
  }
  const type = String(mimetype || '').toLowerCase();
  if (!RINGTONE_MIME_TYPES.includes(type)) {
    return fail(res, 400, 'INVALID_EXTENSION', 'Type de fichier non autorisé');
  }
  const octets = Number(size);
  if (!Number.isInteger(octets) || octets <= 0) {
    return fail(res, 400, 'VALIDATION_FAILED', 'Taille de fichier invalide');
  }
  if (octets > RINGTONE_MAX_BYTES) {
    return fail(res, 413, 'FILE_TOO_LARGE', 'Fichier trop volumineux');
  }

  const key = storage.isB2Enabled()
    ? storage.ringtoneKey({ alanyaID, sha256: empreinte })
    : null;
  if (!key) return res.json({ mode: 'unavailable' });
  const url = storage.publicUrl(key);

  try {
    if (await storage.headObject(key)) return res.json({ mode: 'exists', url });
    const envoi = await storage.presignUpload(key, { contentType: type, contentLength: octets });
    return res.json({
      mode: 'direct',
      method: 'PUT',
      uploadUrl: envoi.url,
      headers: envoi.headers,
      expiresIn: envoi.expiresIn,
      url,
      mimetype: type,
      size: octets,
    });
  } catch (e) {
    console.error('[Upload ticket] sonnerie :', e.message);
    return stockageIndisponible(res);
  }
}

module.exports = { uploadAvatar, uploadMedia, uploadTicket, msgTypeFor };
