/**
 * Refus métier de l'abonnement : un code stable (docs/error-codes.md) et le
 * statut HTTP qui va avec. Les services le lèvent, les contrôleurs le
 * traduisent par `fail()` — aucun service ne connaît `res`.
 */
class BillingError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { BillingError };
