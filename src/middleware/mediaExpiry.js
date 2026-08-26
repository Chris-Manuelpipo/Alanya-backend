/**
 * Lecture des médias partitionnés — expiration dérivée de l'URL.
 *
 * Trois responsabilités, toutes placées DEVANT `express.static` :
 *
 * 1. **`410 Gone` sans toucher au disque.** Le chemin porte le jour de
 *    l'upload, donc l'expiration se calcule sans consulter la base ni ouvrir
 *    le moindre fichier. Deux gains : le client distingue enfin « média
 *    expiré » — état définitif, affichage propre, plus jamais de nouvelle
 *    tentative — de « serveur ou réseau indisponible » ; et le serveur ne fait
 *    aucune entrée-sortie pour les requêtes portant sur des médias morts, qui
 *    resteront nombreuses puisque les vieux messages gardent leur URL dans
 *    l'historique.
 *
 * 2. **Le plafonnement du cache** (`staticHeaders`). Les fichiers d'upload sont
 *    immuables, d'où le `Cache-Control: immutable` d'origine. Mais une URL qui
 *    meurt dans trois jours ne doit pas être gardée un an par un cache
 *    intermédiaire, sinon le 410 n'atteint jamais le client.
 *
 * 3. **Le relais des chemins hérités**, toujours actif. Le nom du fichier porte
 *    l'horodatage de l'upload (`media_<alanyaID>_<epochMs>.<ext>`), donc la
 *    partition d'un fichier déplacé se recalcule à la lecture. C'est ce qui permet de migrer
 *    les fichiers existants SANS toucher aux `mediaUrl` déjà en base : pas
 *    d'`UPDATE` de masse sur la table la plus chaude, pas de fenêtre de
 *    migration, et un retour arrière qui ne coûte rien. Les anciennes URL
 *    meurent d'elles-mêmes en trente jours, après quoi ce relais se retire.
 *
 * Note : la réponse 410 est volontairement indépendante de l'interrupteur
 * `MEDIA_PARTITIONS_ENABLED`. Une URL partitionnée qui existe doit être jugée
 * sur son chemin, y compris après un retour arrière de l'interrupteur — sans
 * quoi une extinction ferait ressusciter des médias en 404 muets.
 */

const fs = require('fs');
const path = require('path');

const { RETENTION } = require('../constants/mediaRetentionPolicy');
const { UPLOADS_DIR } = require('../services/mediaPartitions');
const {
  MEDIA_ROOT,
  LEGACY_KINDS,
  isPartitionExpired,
  isPartitionKey,
  partitionFromPath,
  secondsUntilPartitionExpiry,
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
      error: 'MEDIA_EXPIRED',
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
 * Middleware à monter sur `/uploads`, avant `express.static`.
 *
 * `now` est injectable pour les tests ; en service il n'est jamais fourni.
 */
function mediaExpiryGuard({
  retentionDays = RETENTION.mediaDays,
  now = () => Date.now(),
  // Le relais des anciennes adresses est TOUJOURS actif, indépendamment de
  // `MEDIA_PARTITIONS_ENABLED`.
  //
  // Il avait d'abord été conditionné à cet interrupteur, pour qu'un
  // déploiement sans activation ne change strictement aucune réponse. C'était
  // une erreur, et elle a coupé les médias en production le 25/08/2026 : le
  // script de migration avait déplacé les fichiers, la base pointait toujours
  // vers l'ancien chemin, et plus personne ne faisait le pont — toutes les URL
  // de médias renvoyaient 404.
  //
  // La leçon tient en une phrase : le relais ne répond pas à la question « les
  // partitions sont-elles activées ? » mais à « ce fichier a-t-il bougé ? ».
  // Or c'est le script de migration qui déplace les fichiers, pas
  // l'interrupteur — les deux sont indépendants, et les lier créait une
  // fenêtre où les médias étaient injoignables.
  //
  // Le relais est de toute façon inoffensif quand rien n'a bougé : il ne fait
  // quoi que ce soit QUE si le fichier a disparu de son ancienne adresse.
  // Tant que la migration n'a pas tourné, `express.static` sert normalement et
  // ce code n'est jamais atteint.
  //
  // L'option reste injectable pour les tests.
  relayLegacy = true,
} = {}) {
  return function guard(req, res, next) {
    // `req.path` est relatif au point de montage (`/uploads`).
    const chemin = req.path || '';

    // ── 1. Chemin partitionné : juger sur l'URL, sans toucher au disque ──
    // `req.path` vaut déjà `/media/<partition>/<kind>/<fichier>` sous le point
    // de montage `/uploads`, ce que `partitionFromPath` sait lire tel quel.
    const partition = partitionFromPath(chemin);
    if (partition) {
      if (isPartitionExpired(partition, { retentionDays, now: now() })) {
        return repondreExpire(res, partition, retentionDays);
      }
      return next(); // partition vivante : `express.static` sert le fichier
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
 * Sert un fichier demandé à son ancienne adresse, une fois qu'il a été déplacé
 * dans sa partition.
 *
 * L'ordre compte : on ne fait ce travail QUE si le fichier n'est plus à
 * l'ancienne place. Tant que la migration n'a pas tourné, ce relais ne coûte
 * rien — `express.static` sert normalement et ce code n'est jamais atteint.
 */
function relaisHerite(req, res, next, { kind, nom, retentionDays, maintenant }) {
  if (!NOM_SUR.test(nom)) return next();

  // Toujours à l'ancienne adresse : rien à faire, `express.static` s'en charge.
  const ancien = path.join(UPLOADS_DIR, MEDIA_ROOT, kind, nom);
  if (fs.existsSync(ancien)) return next();

  // Le nom porte l'horodatage de l'upload : la partition se recalcule sans la
  // base. Un nom hors convention (import manuel, reliquat) n'est pas relayé.
  const uploadMs = uploadMsFromFileName(nom);
  if (uploadMs === null) return next();

  const partition = partitionKeyFor(uploadMs);
  if (!isPartitionKey(partition)) return next();

  // Le fichier a bien été déplacé, mais sa partition est déjà tombée : c'est
  // une expiration, pas une absence. Le client doit lire 410, pas 404.
  if (isPartitionExpired(partition, { retentionDays, now: maintenant })) {
    return repondreExpire(res, partition, retentionDays);
  }

  const cible = path.join(UPLOADS_DIR, MEDIA_ROOT, partition, kind, nom);
  if (!fs.existsSync(cible)) return next(); // vraie absence : 404 par la suite

  const restant = secondsUntilPartitionExpiry(partition, { retentionDays, now: maintenant });
  res.set('Cache-Control', `public, max-age=${restant}`);
  return res.sendFile(cible, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

/**
 * En-têtes de `express.static`, à passer en `setHeaders`.
 *
 * Les noms de fichiers sont uniques, donc une URL désigne toujours le même
 * contenu : `immutable` reste correct. Mais le `max-age` d'un média
 * partitionné ne peut pas dépasser la vie restante de sa partition, sinon un
 * cache intermédiaire continuerait de servir un fichier que le serveur a
 * supprimé, et le 410 n'arriverait jamais jusqu'au client.
 */
function staticHeaders({ retentionDays = RETENTION.mediaDays, now = () => Date.now() } = {}) {
  const UN_AN = 31536000;
  return (res, cheminFichier) => {
    const partition = partitionFromPath(cheminFichier);
    if (!partition) {
      // Avatars et chemins hérités : pas d'expiration, comportement inchangé.
      res.setHeader('Cache-Control', `public, max-age=${UN_AN}, immutable`);
      return;
    }
    const restant = secondsUntilPartitionExpiry(partition, { retentionDays, now: now() });
    res.setHeader('Cache-Control', `public, max-age=${Math.min(UN_AN, restant)}, immutable`);
  };
}

module.exports = { mediaExpiryGuard, staticHeaders, GONE_MAX_AGE };
