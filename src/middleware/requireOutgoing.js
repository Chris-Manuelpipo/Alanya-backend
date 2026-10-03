const { fail } = require('../utils/apiError');
const { checkOutgoing, OUTGOING_DENIED } = require('../services/billing/outgoingGate');

/**
 * Verrou serveur de tout ce qui SORT d'un compte : un message, un transfert,
 * une réaction, un statut, un appel, une réunion. Un compte dont l'essai est fini
 * et qui n'a pas d'abonnement ne fait que recevoir.
 *
 * Refus en 403 `SUBSCRIPTION_REQUIRED` avec `feature: "outgoing"` : l'application
 * en fait le panneau de l'offre, pas un message d'erreur. À poser après `auth`.
 *
 * Ne ferme jamais faute de calcul (voir outgoingGate.js).
 */
async function requireOutgoing(req, res, next) {
  const verdict = await checkOutgoing(req.user.alanyaID);
  if (verdict.allowed) return next();
  return fail(res, 403, OUTGOING_DENIED.code, OUTGOING_DENIED.message, {
    feature: OUTGOING_DENIED.feature,
  });
}

module.exports = requireOutgoing;
