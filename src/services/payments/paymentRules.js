/**
 * Règles pures du paiement : aucune base, aucun réseau.
 *
 * Testées par paymentRules.test.js (CI). Le service (paymentService.js) et le
 * simulateur (providers/simulated.js) ne font qu'appliquer ces fonctions.
 */

const crypto = require('crypto');

const PAYMENT_STATUS_NAME = Object.freeze({
  0: 'created',
  1: 'pending',
  2: 'succeeded',
  3: 'failed',
  4: 'expired',
  5: 'refunded',
});

/**
 * Numéro mobile money, normalisé en chiffres avec indicatif.
 *
 * Un numéro camerounais (9 chiffres commençant par 6) est accepté avec ou
 * sans 237 ; ailleurs, l'indicatif est exigé. Refuse ce qui ne peut pas être
 * un numéro plutôt que de laisser l'opérateur échouer plus tard.
 *
 * @returns {string|null}
 */
function normalizeMsisdn(raw) {
  const digits = String(raw ?? '')
    .replace(/[\s().-]/g, '')
    .replace(/^\+/, '')
    .replace(/^00/, '');
  if (!/^\d{8,15}$/.test(digits)) return null;
  if (digits.startsWith('237')) {
    return /^6\d{8}$/.test(digits.slice(3)) ? digits : null;
  }
  if (/^6\d{8}$/.test(digits)) return `237${digits}`;
  return digits.length >= 10 ? digits : null;
}

/**
 * Ce que le simulateur répond, d'après les deux derniers chiffres du numéro.
 * Chaque cas doit pouvoir être vu à l'écran avant d'arriver en vrai.
 */
function simulatedOutcome(msisdn) {
  const tail = String(msisdn ?? '').replace(/\D/g, '').slice(-2);
  switch (tail) {
    case '01': return { outcome: 'failed', failureCode: 'INSUFFICIENT_FUNDS' };
    case '02': return { outcome: 'failed', failureCode: 'USER_DECLINED' };
    case '03': return { outcome: 'none' };
    case '04': return { outcome: 'succeeded', duplicate: true };
    default: return { outcome: 'succeeded' };
  }
}

function signSimulated(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Comparaison en temps constant : une signature ne se devine pas octet par octet. */
function verifySimulated(rawBody, signature, secret) {
  const expected = Buffer.from(signSimulated(rawBody, secret));
  const got = Buffer.from(String(signature || ''));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/**
 * Ajoute des mois calendaires, en UTC, sans déborder : un abonnement pris le
 * 31 janvier finit le 28 (ou 29) février, pas le 3 mars.
 */
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

const time = (v) => {
  if (v == null) return -Infinity;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * Début d'une nouvelle période : maintenant, sauf si une période court encore
 * (payer en avance prolonge, sans chevauchement) ou si la grâce n'est pas
 * finie (payer pendant la grâce ne consomme pas les jours gratuits).
 */
function nextPeriodStart({ now = new Date(), currentEnd = null, graceUntil = null }) {
  return new Date(Math.max(now.getTime(), time(currentEnd), time(graceUntil)));
}

module.exports = {
  PAYMENT_STATUS_NAME,
  normalizeMsisdn,
  simulatedOutcome,
  signSimulated,
  verifySimulated,
  addMonths,
  nextPeriodStart,
};
