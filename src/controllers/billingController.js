const { failInternal } = require('../utils/apiError');
const { entitlementsFor } = require('../services/billing/entitlements');

/**
 * GET /api/billing/me — les droits du compte connecté.
 *
 * La même charge utile voyage dans /auth/me ; cette route sert au
 * rafraîchissement ciblé (retour au premier plan, `validUntil` échu) sans
 * relire tout le profil.
 */
const getMyEntitlements = async (req, res) => {
  try {
    res.json(await entitlementsFor(req.user.alanyaID));
  } catch (err) {
    console.error('[billing] droits du compte :', err);
    return failInternal(res);
  }
};

module.exports = { getMyEntitlements };
