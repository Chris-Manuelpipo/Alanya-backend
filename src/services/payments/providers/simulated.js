/**
 * Faux agrégateur de paiement.
 *
 * Il répond comme un vrai : `initiate` rend « en attente », puis la réponse
 * arrive plus tard, par un job qui rappelle EXACTEMENT la fonction qu'emprunte
 * un webhook HTTP (paymentService.handleWebhook), signature comprise. Le
 * parcours éprouvé aujourd'hui est donc celui qui servira demain : brancher un
 * agrégateur, c'est écrire un fichier voisin de celui-ci, rien d'autre.
 *
 * Issue selon les deux derniers chiffres du numéro (paymentRules.js) :
 * 00 et tout autre → succès · 01 → solde insuffisant · 02 → refus ·
 * 03 → aucune réponse · 04 → succès envoyé deux fois.
 *
 * En production, l'interrupteur refuse de s'activer tant que ce fournisseur
 * est actif : seuls les comptes testeurs peuvent l'atteindre.
 */

const crypto = require('crypto');
const { enqueue } = require('../../jobQueue');
const { simulatedOutcome, signSimulated, verifySimulated } = require('../paymentRules');

const name = 'simulated';
const channels = ['orange_money', 'mtn_momo'];

/** Délai de la « réponse de l'opérateur » : de quoi voir l'écran d'attente. */
const RESPONSE_DELAY_MS = 4000;

const secret = () => process.env.PAYMENT_SIMULATOR_SECRET || 'simulateur-alanya-local';

function sign(rawBody) {
  return signSimulated(rawBody, secret());
}

async function initiate({ msisdn }) {
  const providerRef = `SIM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const plan = simulatedOutcome(msisdn);
  if (plan.outcome !== 'none') {
    const event = { providerRef, outcome: plan.outcome, failureCode: plan.failureCode ?? null };
    const repeats = plan.duplicate ? 2 : 1;
    for (let i = 0; i < repeats; i++) {
      await enqueue('payment_sim_callback', event, {
        dedupeKey: `sim:${providerRef}:${i}`,
        runAfter: new Date(Date.now() + RESPONSE_DELAY_MS + i * 1500),
      });
    }
  }
  return { providerRef, status: 'pending', nextAction: { type: 'ussd_push' } };
}

function parseWebhook({ headers, rawBody }) {
  const signatureOk = verifySimulated(rawBody, headers?.['x-simulator-signature'], secret());
  const body = JSON.parse(rawBody.toString('utf8'));
  return {
    signatureOk,
    providerRef: body.providerRef ?? null,
    outcome: body.outcome,
    failureCode: body.failureCode ?? null,
    eventType: String(body.outcome || 'inconnu'),
    raw: body,
  };
}

/** Le simulateur n'a pas de mémoire : un paiement sans réponse reste en attente, puis expire. */
async function fetchStatus() {
  return { outcome: 'pending' };
}

module.exports = { name, channels, initiate, parseWebhook, fetchStatus, sign };
