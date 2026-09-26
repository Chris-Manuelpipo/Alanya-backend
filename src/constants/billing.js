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
  // Déclaré au catalogue avec `is_paid = 0` (migration 087) : le code existe
  // pour que la bascule au payant soit un réglage, pas une migration. Aucun
  // `requireFeature` ne s'en sert aujourd'hui.
  VOICEMAIL: 'voicemail',
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
  // Achat d'un numéro Alanya choisi (migration 089) : aucun plan, aucune
  // période — ce qui est acheté se lit dans `alanya_phone_order`.
  PHONE_NUMBER: 3,
});

/** `alanya_phone_order.status` (migration 089) */
const PHONE_ORDER_STATUS = Object.freeze({
  HELD: 0,
  PAYING: 1,
  APPLIED: 2,
  ABANDONED: 3,
  // Payé, mais le numéro n'a pas pu être posé : l'utilisateur en choisit un
  // autre sans repayer. Aucun paiement ne reste sans contrepartie.
  CREDIT: 4,
});

/** `alanya_phone_history.source` */
const PHONE_CHANGE_SOURCE = Object.freeze({
  PURCHASE: 0,
  ADMIN: 1,
});

/**
 * Le numéro choisi : un achat à part, hors abonnement.
 *
 * Le prix est recopié dans `payment.amount` au moment du paiement : le changer
 * ici ne touche aucun paiement passé. La mise de côté couvre le temps de
 * lancer le paiement ; une fois la demande partie chez l'opérateur, le numéro
 * reste retenu jusqu'à sa réponse, quelle que soit cette durée. La quarantaine
 * empêche qu'un inconnu reçoive, pendant des semaines, les appels et les
 * recherches destinés à l'ancien titulaire — qui, lui, peut le reprendre.
 */
const PHONE_CHANGE = Object.freeze({
  price: 1000,
  currency: 'XAF',
  holdMinutes: 15,
  quarantineDays: 90,
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
  PHONE_ORDER_STATUS,
  PHONE_CHANGE_SOURCE,
  PHONE_CHANGE,
  MIN_GRACE_DAYS,
  OFFLINE_TRUST_DAYS,
};
