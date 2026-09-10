/**
 * Registre des fournisseurs de paiement.
 *
 * Chaque fournisseur est un module de même forme :
 *   name, channels,
 *   initiate({ paymentId, amount, currency, msisdn }) → { providerRef, status, nextAction }
 *   parseWebhook({ headers, rawBody }) → { signatureOk, providerRef, outcome, failureCode, eventType, raw }
 *   fetchStatus(providerRef) → { outcome, failureCode }
 *
 * Brancher un agrégateur : écrire son module, l'ajouter ici, changer
 * PAYMENT_PROVIDER. Ni l'abonnement, ni la coche, ni l'application ne bougent.
 */

const simulated = require('./simulated');
const { BillingError } = require('../../billing/errors');
const { paymentProvider } = require('../../billing/rules');

const REGISTRY = Object.freeze({
  [simulated.name]: simulated,
});

function get(name) {
  return REGISTRY[name] || null;
}

/** Le fournisseur actif (variable PAYMENT_PROVIDER). */
function active(env = process.env) {
  const name = paymentProvider(env);
  const provider = get(name);
  if (!provider) {
    throw new BillingError('PAYMENT_PROVIDER_UNKNOWN', 503, `Fournisseur de paiement inconnu : ${name}`);
  }
  return provider;
}

module.exports = { get, active };
