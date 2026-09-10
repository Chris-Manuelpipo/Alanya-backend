/**
 * Constantes de l'abonnement Alanya Plus (volet 8 de la conception).
 *
 * Les valeurs numériques sont stockées en base (migration 080) : ne jamais
 * renuméroter. Les codes de fonctionnalité sont ceux du catalogue `feature` —
 * c'est le code qui les connaît, l'administration ne peut pas en inventer.
 */

/** Phase du payant, déduite de `billing_settings` et de l'heure. */
const PHASE = Object.freeze({
  FREE: 'free',
  GRACE: 'grace',
  PAID: 'paid',
});

const FEATURE = Object.freeze({
  TRANSLATION: 'translation',
  BACKUP: 'backup',
  TRUSTED_TRIPS: 'trusted_trips',
  LIST_RINGTONES: 'list_ringtones',
  STYLE: 'style',
  VERIFIED_BADGE: 'verified_badge',
});

/** `subscription_period.source` */
const PERIOD_SOURCE = Object.freeze({
  PAYMENT: 0,
  TRIAL: 1,
  GIFT: 2,
  COMPENSATION: 3,
});

/** `payment.status` */
const PAYMENT_STATUS = Object.freeze({
  CREATED: 0,
  PENDING: 1,
  SUCCEEDED: 2,
  FAILED: 3,
  EXPIRED: 4,
  REFUNDED: 5,
});

/** `payment.purpose` */
const PAYMENT_PURPOSE = Object.freeze({
  SUBSCRIBE: 0,
  RENEW: 1,
  AUTO_RENEW: 2,
});

/** Aucun passage au payant sans préavis (contrainte ck_billing_grace). */
const MIN_GRACE_DAYS = 7;

/**
 * Jusqu'à quand le téléphone peut se fier à ses droits sans réseau, au plus.
 * La traduction fonctionne hors ligne : ses droits doivent le pouvoir aussi.
 */
const OFFLINE_TRUST_DAYS = 7;

module.exports = {
  PHASE,
  FEATURE,
  PERIOD_SOURCE,
  PAYMENT_STATUS,
  PAYMENT_PURPOSE,
  MIN_GRACE_DAYS,
  OFFLINE_TRUST_DAYS,
};
