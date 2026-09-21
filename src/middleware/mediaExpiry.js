/**
 * Lecture des médias partitionnés — expiration dérivée de l'URL.
 *
 * Deux responsabilités, toutes deux placées DEVANT `mediaRead` :
 *
 * 1. **`410 Gone` sans rien demander à Backblaze.** Le chemin porte le jour de
 *    l'upload, donc l'expiration se calcule sans consulter la base ni signer
 *    le moindre lien. Deux gains : le client distingue enfin « média expiré »
 *    — état définitif, affichage propre, plus jamais de nouvelle tentative —
 *    de « serveur ou réseau indisponible » ; et le serveur n'appelle pas le
 *    stockage pour des médias morts, dont les requêtes resteront nombreuses
 *    puisque les vieux messages gardent leur URL dans l'historique.
 *
 * 2. **Le relais des chemins hérités.** Le nom du fichier porte l'horodatage de
 *    l'upload (`media_<alanyaID>_<epochMs>.<ext>`), donc la partition d'un
 *    média rangé avant le découpage en tranches se recalcule à la lecture.
 *    C'est ce qui a permis de migrer les fichiers existants SANS toucher aux
 *    `mediaUrl` déjà en base : pas d'`UPDATE` de masse sur la table la plus
 *    chaude, pas de fenêtre de migration. Ces anciennes URL meurent d'elles-
 *    mêmes au terme de la rétention, après quoi ce relais se retire.
 */

const { RETENTION } = require('../constants/mediaRetentionPolicy');
const {
  MEDIA_ROOT,
  LEGACY_KINDS,
  isPartitionExpired,
  isPartitionKey,
  partitionFromPath,
  uploadMsFromFileName,
  partitionKeyFor,
} = require('../utils/mediaPartition');

/**
 * Durée pendant laquelle un 410 peut être mis en cache.
 * Un média expiré le reste : rien ne justifie de redemander au serveur.
 */
const GONE_MAX_AGE = 86400;

/** Un nom de fichier d'upload, et rien d'autre — aucun séparateur, aucune remontée. */
const NOM_SUR = /^[A-Za-z0-9._-]+$/;

/**
 * Réponse « ce média a expiré ».
 *
 * Le corps est du JSON même si la requête visait une image : le client doit
 * pouvoir lire la raison. `MEDIA_EXPIRED` est le contrat côté application —
 * il déclenche l'affichage « Média expiré » et l'abandon définitif des
 * tentatives, là où un 404 ou un timeout laisse croire à une panne passagère.
 */
function repondreExpire(res, partition, retentionDays) {
  res.status(410)
    .set('Cache-Control', `public, max-age=${GONE_MAX_AGE}`)
    .json({
      // `error` porte le code par exception ici : des clients déployés le
      // lisent à cette place. `code` s'y ajoute pour rejoindre le contrat
      // commun, sans casser ceux qui n'ont pas encore été mis à jour.
      error: 'MEDIA_EXPIRED',
      code: 'MEDIA_EXPIRED',
      partition,
      // La rétention RÉELLEMENT appliquée à cette décision, pas celle de la
      // politique globale. Les deux divergent dès qu'un appelant en injecte
      // une autre — surcharge depuis l'espace super-admin, ou réglage
      // temporaire de mise en service. Annoncer au client une durée qui n'est
      // pas celle qui vient de le priver du média serait un mensonge poli.
      retentionDays,
    });
}

/**
 * Middleware à monter sur `/uploads`, avant `mediaRead`.
 *
 * `now` est injectable pour les tests ; en service il n'est jamais fourni.
 */
function mediaExpiryGuard({
  retentionDays = RETENTION.mediaDays,
  now = () => Date.now(),
  // Le relais des anciennes adresses reste injectable pour les tests. En
  // service il est toujours actif : couper le pont entre une `mediaUrl`
  // d'avant le découpage et la clé où le fichier a réellement été rangé rend
  // ces médias injoignables, ce qui est arrivé en production le 25/08/2026.
  relayLegacy = true,
} = {}) {
  return function guard(req, res, next) {
    // `req.path` est relatif au point de montage (`/uploads`).
    const chemin = req.path || '';

    // ── 1. Chemin partitionné : juger sur l'URL, sans appeler le stockage ──
    // `req.path` vaut déjà `/media/<partition>/<kind>/<fichier>` sous le point
    // de montage `/uploads`, ce que `partitionFromPath` sait lire tel quel.
    const partition = partitionFromPath(chemin);
    if (partition) {
      if (isPartitionExpired(partition, { retentionDays, now: now() })) {
        return repondreExpire(res, partition, retentionDays);
      }
      return next(); // partition vivante : `mediaRead` signe le lien
    }

    // ── 2. Chemin hérité `media/<kind>/<fichier>` : relais vers la partition ──
    const segments = chemin.split('/').filter(Boolean);
    if (relayLegacy
        && segments.length === 3
        && segments[0] === MEDIA_ROOT
        && LEGACY_KINDS.includes(segments[1])) {
      return relaisHerite(req, res, next, {
        kind: segments[1],
        nom: segments[2],
        retentionDays,
        maintenant: now(),
      });
    }

    return next();
  };
}

/**
 * Traduit une ancienne adresse `media/<kind>/<fichier>` en la clé de partition
 * sous laquelle le fichier a réellement été rangé, puis laisse `mediaRead`
 * signer le lien.
 *
 * Rien n'est lu ni vérifié : le nom du fichier suffit au calcul. Si la clé
 * n'existe pas chez Backblaze, la redirection aboutira à un 404 du stockage —
 * même résultat qu'une absence, sans avoir payé un appel réseau pour le
 * savoir.
 */
function relaisHerite(req, res, next, { kind, nom, retentionDays, maintenant }) {
  if (!NOM_SUR.test(nom)) return next();

  // Le nom porte l'horodatage de l'upload : la partition se recalcule sans la
  // base. Un nom hors convention (import manuel, reliquat) n'est pas relayé.
  const uploadMs = uploadMsFromFileName(nom);
  if (uploadMs === null) return next();

  const partition = partitionKeyFor(uploadMs);
  if (!isPartitionKey(partition)) return next();

  // La partition est déjà tombée : c'est une expiration, pas une absence. Le
  // client doit lire 410, pas 404.
  if (isPartitionExpired(partition, { retentionDays, now: maintenant })) {
    return repondreExpire(res, partition, retentionDays);
  }

  req.mediaKey = `${MEDIA_ROOT}/${partition}/${kind}/${nom}`;
  return next();
}

module.exports = { mediaExpiryGuard, GONE_MAX_AGE };
