/**
 * Refus métier de l'abonnement : un code stable (docs/error-codes.md), le
 * statut HTTP qui va avec, et d'éventuels champs d'appoint (ex. l'identifiant
 * du paiement déjà en attente). Les services le lèvent, les contrôleurs le
 * traduisent par `fail()` — aucun service ne connaît `res`.
 */
class BillingError extends Error {
  constructor(code, status, message, extra) {
    super(message || code);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { BillingError };
