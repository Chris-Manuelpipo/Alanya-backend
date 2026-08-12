const express = require('express');
const router = express.Router();
const { authCustom } = require('../middleware/authCustom');

/**
 * Source des tuiles cartographiques, **servie et non compilée**.
 *
 * Le client embarque un repli, mais interroge cette route au démarrage. C'est ce
 * qui permet de changer de fournisseur — bascule vers nos propres tuiles, clé
 * commerciale de secours, retour en arrière après un incident — **sans publier
 * une version sur les magasins**. Une publication met des jours à atteindre le
 * parc, et une partie des utilisateurs ne met jamais à jour : si l'URL était
 * dans le binaire, le jour du basculement une carte blanche s'afficherait
 * pendant des semaines chez une partie des gens.
 *
 * C'est le même raisonnement que `tripPolicy.publicPolicy()` : ce qui peut
 * changer côté exploitation ne se fige pas dans une application.
 *
 * L'attribution voyage avec l'URL, et ce n'est pas cosmétique : elle est la
 * contrepartie juridique du droit d'usage. Les découpler, c'est se garantir
 * d'afficher un jour la mention d'un fournisseur qu'on n'utilise plus.
 */

const readInt = (nom, defaut) => {
  const v = parseInt(process.env[nom], 10);
  return Number.isInteger(v) ? v : defaut;
};

/**
 * ⚠ Par défaut, la feuille OpenStreetMap standard.
 *
 * Elle tourne sur les ressources données à la fondation OSM, et sa politique
 * d'usage n'autorise qu'un usage léger. Un trajet suivi par un cercle de cinq
 * personnes charge des centaines de tuiles ; à l'échelle du produit, on sort du
 * cadre. **C'est le défaut de développement, pas de production.**
 *
 * En production, renseigner `MAP_TILE_URL` — voir `docs/exploitation/tuiles.md`.
 */
const tileConfig = () => ({
  version: 1,
  url: process.env.MAP_TILE_URL
    || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: process.env.MAP_TILE_ATTRIBUTION || '© OpenStreetMap',
  maxZoom: readInt('MAP_TILE_MAX_ZOOM', 19),
  // Durée de conservation d'une tuile sur l'appareil. Une carte de rue ne
  // bouge pas d'un jour à l'autre : trente jours économisent l'essentiel des
  // requêtes sans jamais montrer une ville périmée.
  cacheDays: readInt('MAP_TILE_CACHE_DAYS', 30),
});

/**
 * @swagger
 * /api/map/tiles:
 *   get:
 *     summary: Source des tuiles cartographiques et sa mention légale
 *     tags: [Carte]
 *     security:
 *       - bearerAuth: []
 */
router.get('/tiles', authCustom, (_req, res) => {
  // Court, et volontairement : c'est le levier de bascule. Une heure de cache
  // HTTP suffit à éviter le martèlement, et laisse un changement se propager
  // dans la journée plutôt qu'à la prochaine réinstallation.
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(tileConfig());
});

module.exports = router;
module.exports.tileConfig = tileConfig;
