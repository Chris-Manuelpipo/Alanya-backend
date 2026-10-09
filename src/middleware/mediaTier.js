const { fail } = require('../utils/apiError');
const { limitsFor } = require('../services/billing/uploadLimits');

/** Entêtes et bornes d'un envoi multipart : le corps dépasse un peu le fichier. */
const MULTIPART_OVERHEAD = 1024 * 1024;

/**
 * Plafond d'envoi d'un média, selon le palier du compte (100 Mo, 200 Mo pour qui
 * a payé). À poser AVANT multer : un envoi manifestement trop gros est refusé
 * sur sa seule taille annoncée, sans que le fichier soit écrit en transit.
 *
 * Le plafond est posé sur la requête (`req.mediaMaxBytes`) : le contrôleur le
 * relit contre la taille réelle du fichier, qu'un `Content-Length` menteur ou
 * absent (envoi par morceaux) n'a pas arrêté.
 */
async function enforceMediaTier(req, res, next) {
  const { maxUploadBytes } = await limitsFor(req.user.alanyaID);
  req.mediaMaxBytes = maxUploadBytes;
  const announced = Number(req.headers['content-length']);
  if (Number.isFinite(announced) && announced > maxUploadBytes + MULTIPART_OVERHEAD) {
    return fail(res, 413, 'FILE_TOO_LARGE', 'Fichier trop volumineux', { maxBytes: maxUploadBytes });
  }
  return next();
}

module.exports = { enforceMediaTier, MULTIPART_OVERHEAD };
