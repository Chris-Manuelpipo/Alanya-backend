/**
 * Lecture des médias stockés chez Backblaze — redirection vers un lien signé.
 *
 * Monté sur `/uploads`, APRÈS `mediaExpiryGuard` (qui a déjà répondu `410`
 * aux médias échus, sans rien demander à Backblaze). Aucun fichier n'est plus
 * servi depuis le disque du serveur : ce middleware est le seul à répondre.
 *
 * `302` vers un lien signé pour la méthode de la requête : un `HEAD` sur un
 * lien signé pour `GET` serait refusé, et l'application envoie un `HEAD` avant
 * ses téléchargements automatiques.
 *
 * La redirection porte `Cache-Control: no-store` : un lien signé ne doit
 * survivre dans aucun cache au-delà de sa validité. Les octets, eux, arrivent
 * de Backblaze avec l'en-tête `immutable` posé au dépôt.
 *
 * ── Fichiers publics ──
 *
 * Une photo, une annonce, une sonnerie ou un média officiel est normalement
 * lu par son adresse Backblaze directe, sans passer ici. Restent les anciennes
 * adresses (`/uploads/images/…`), en base avant la répartition ou gardées par
 * un téléphone. Tant que les fichiers n'ont pas été copiés dans les buckets
 * publics, elles sont lues dans le bucket privé, où ils se trouvent encore.
 * Une fois la copie faite (`MEDIA_PUBLIC_MIGRATED`), elles sont redirigées
 * vers le bucket public — une redirection qui peut rester en cache : le
 * fichier désigné ne change jamais.
 */

const storage = require('../services/mediaStorage');
const { fail } = require('../utils/apiError');

function mediaRead() {
  return async function lire(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // Posée par le relais des adresses héritées : la clé de partition d'un
    // média d'avant le découpage en tranches.
    const key = req.mediaKey || storage.keyFromPath(req.path);
    if (!key) return next();

    if (!storage.isB2Enabled()) {
      return fail(res, 503, 'STORAGE_UNAVAILABLE', 'Stockage des médias indisponible');
    }

    const cible = storage.cibleDe(key);
    if (cible.publique && storage.STORAGE.publicMigrated) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, storage.publicUrl(key));
    }

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
