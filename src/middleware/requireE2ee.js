const { fail } = require('../utils/apiError');
const { peutPublier } = require('../services/e2eeSettingsService');

/**
 * Garde des routes `/api/e2ee/*` : le compte doit être dans la cohorte, et le
 * premier cran de l'interrupteur ouvert (migration 094).
 *
 * Refus en 404 `E2EE_INACTIF`. 404 et non 403 : pour l'application, le
 * chiffrement n'existe simplement pas encore pour ce compte — elle ne publie
 * rien et continue en clair, sans afficher d'erreur ni réessayer en boucle.
 *
 * ⚠ À revoir avant d'ouvrir le second cran (`activate_enabled`) : une
 * conversation déjà chiffrée doit pouvoir continuer d'obtenir des paquets et
 * la liste des appareils même si l'on referme le premier cran. Aujourd'hui
 * aucune conversation ne l'est, et tout fermer est le comportement voulu.
 */
async function requireE2ee(req, res, next) {
  if (await peutPublier(req.user.alanyaID)) return next();
  return fail(res, 404, 'E2EE_INACTIF', 'Chiffrement de bout en bout non disponible pour ce compte');
}

module.exports = requireE2ee;
