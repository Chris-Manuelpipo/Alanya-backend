const { fail } = require('../utils/apiError');
const { entitlementsOrNull } = require('../services/billing/entitlements');

/**
 * Verrou serveur d'une fonctionnalité Alanya Plus.
 *
 * Refus en 403 `SUBSCRIPTION_REQUIRED`, avec le code de la fonctionnalité :
 * l'application en fait le panneau de l'offre, pas un message d'erreur.
 *
 * Ne ferme jamais faute de calcul : sans droits (migration absente, base
 * indisponible), la requête passe. Une fonctionnalité inconnue du catalogue
 * n'est pas verrouillée non plus.
 *
 * @param {string} featureCode  code du catalogue (constants/billing.js FEATURE)
 */
function requireFeature(featureCode) {
  return async (req, res, next) => {
    const entitlements = await entitlementsOrNull(req.user.alanyaID);
    if (entitlements && entitlements.features[featureCode] === false) {
      return fail(res, 403, 'SUBSCRIPTION_REQUIRED', 'Fonctionnalité réservée à Alanya Plus', {
        feature: featureCode,
      });
    }
    return next();
  };
}

module.exports = requireFeature;
