/**
 * Lecture des médias — redirection vers un lien signé Backblaze.
 *
 * Monté sur `/uploads`, APRÈS `mediaExpiryGuard` (qui a déjà répondu `410` aux
 * médias échus, sans rien demander à Backblaze). C'est le dernier maillon :
 * plus rien n'est servi depuis le disque du serveur.
 *
 * La redirection est en `302` vers un lien signé pour la méthode de la requête
 * — un `HEAD` sur un lien signé pour `GET` serait refusé, et l'application
 * envoie un `HEAD` avant ses téléchargements automatiques.
 *
 * Elle porte `Cache-Control: no-store` : un lien signé ne doit survivre dans
 * aucun cache au-delà de sa validité. Les octets, eux, arrivent de Backblaze
 * avec l'en-tête `immutable` posé au dépôt.
 */

const storage = require('../services/mediaStorage');
const { fail } = require('../utils/apiError');

function mediaRead() {
  return async function lire(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // Posée par le relais des adresses héritées : la clé de partition d'un
    // média dont l'URL en base précède le découpage en tranches.
    const key = req.mediaKey || storage.keyFromPath(req.path);
    if (!key) return next();

    try {
      const url = await storage.presignRead(key, req.method);
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, url);
    } catch (e) {
      console.error('[MediaRead] signature impossible:', e.message);
      return fail(res, 503, 'STORAGE_UNAVAILABLE', 'Stockage des médias indisponible');
    }
  };
}

module.exports = { mediaRead };
