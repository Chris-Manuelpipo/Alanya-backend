/**
 * Lecture des médias stockés chez Backblaze — redirection vers un lien signé.
 *
 * Monté sur `/uploads`, APRÈS `mediaExpiryGuard` (qui a déjà répondu `410`
 * aux médias échus, sans rien demander à Backblaze) et AVANT `express.static`.
 *
 * - **Stockage disque** : ne fait rien, `express.static` sert comme avant.
 * - **Stockage objet** : un fichier encore présent sur le disque — pendant la
 *   transition — est servi comme avant. Sinon, `302` vers un lien signé pour
 *   la méthode de la requête : un `HEAD` sur un lien signé pour `GET` serait
 *   refusé, et l'application envoie un `HEAD` avant ses téléchargements
 *   automatiques.
 *
 * La redirection porte `Cache-Control: no-store` : un lien signé ne doit
 * survivre dans aucun cache au-delà de sa validité. Les octets, eux, arrivent
 * de Backblaze avec l'en-tête `immutable` posé au dépôt.
 *
 * La question posée pendant la transition est « le fichier est-il encore sur
 * le disque ? », jamais « l'interrupteur est-il allumé ? » : c'est la leçon du
 * 25/08/2026 (voir `mediaExpiry.js`), où lier les deux avait coupé les médias.
 */

const fs = require('fs');

const storage = require('../services/mediaStorage');
const { UPLOADS_DIR } = require('../services/mediaPartitions');
const { fail } = require('../utils/apiError');

function mediaRead({ root = UPLOADS_DIR } = {}) {
  return async function lire(req, res, next) {
    if (!storage.isB2Enabled()) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // Posée par le relais des adresses héritées : la clé de partition d'un
    // fichier que le relais n'a pas trouvé sur le disque.
    const key = req.mediaKey || storage.keyFromPath(req.path);
    if (!key) return next();
    if (!req.mediaKey && fs.existsSync(storage.diskPathForKey(key, root))) return next();

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
