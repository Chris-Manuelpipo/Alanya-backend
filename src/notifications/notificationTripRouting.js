/**
 * Acheminement des notifications de trajet de confiance.
 *
 * Module **pur**, sur le modèle de `notificationAndroidNative.js` : la décision
 * — visible ou non, quel canal, quel TTL, quelle couleur — est prise ici et
 * testée ici. Elle vivait auparavant en ligne dans `sendDataOnlyNotification`,
 * mêlée à l'appel Firebase, donc intestable sans réseau.
 *
 * Ce n'est pas de la cosmétique. Trois défauts s'y étaient logés, tous
 * invisibles à la lecture et tous fatals à une alerte de sûreté :
 *
 *  1. les types de trajet n'étaient pas « visibles » : `_buildApnsConfig` ne
 *     posait aucun `aps.alert` et envoyait en `apns-push-type: background`.
 *     Sur iOS, l'alerte n'affichait rien et se faisait étrangler par Apple ;
 *  2. la priorité retombait à `normal` et le TTL à 24 h, donc une alerte
 *     retardable de plusieurs heures par Doze ;
 *  3. le canal était celui des messages, qu'un mode silencieux étouffe.
 */

/** Les deux seuls types de toute l'application qui réveillent quelqu'un. */
const TRIP_ALERT_TYPES = ['trip_alert', 'trip_sos'];

/** Rappels au propriétaire : visibles et prioritaires, mais qui ne forcent rien. */
const TRIP_OWNER_TYPES = ['trip_eta_soon', 'trip_due', 'trip_reminder'];

const TRIP_TYPES = [...TRIP_ALERT_TYPES, ...TRIP_OWNER_TYPES, 'trip_closed'];

/**
 * Canal Android. L'identifiant doit correspondre **exactement** à celui créé
 * par le client (`local_notification_helper.dart`) : un canal inconnu fait
 * retomber Android sur un canal par défaut, et le contournement du mode
 * silencieux est perdu sans le moindre signe.
 */
const CANAL_ALERTE = 'alanya_trip_alert';
const CANAL_TRAJET = 'alanya_trip';

/**
 * Durée de vie par type. Une notification de sûreté périmée est pire
 * qu'absente : elle apprend au destinataire que les alertes de l'application
 * arrivent en retard, et il cesse de les ouvrir.
 */
const TTL_MS = {
  trip_alert: 120_000,
  trip_sos: 120_000,
  trip_eta_soon: 600_000,
  trip_due: 900_000,
  trip_reminder: 600_000,
  // Une clôture n'est pas urgente : elle rassure, elle ne réveille pas.
  trip_closed: 86_400_000,
};

const isTripType = (type) => TRIP_TYPES.includes(String(type || ''));
const isTripAlert = (type) => TRIP_ALERT_TYPES.includes(String(type || ''));

/**
 * @param {string} type
 * @returns {{visible: boolean, channelId: string, ttlMs: number,
 *            color: string, bypassSilence: boolean}|null}
 *          `null` si ce n'est pas un type de trajet.
 */
const resolveTripPush = (type) => {
  const t = String(type || '');
  if (!isTripType(t)) return null;

  const alerte = isTripAlert(t);
  return {
    // Tous les types de trajet s'affichent. Aucun n'est un envoi silencieux :
    // un trajet qui ne dit rien ne sert à rien.
    visible: true,
    channelId: alerte ? CANAL_ALERTE : CANAL_TRAJET,
    ttlMs: TTL_MS[t],
    // Rouge pour une alerte : la teinte de la pastille système est le seul
    // signal lisible avant d'avoir lu quoi que ce soit.
    color: alerte ? '#EF4444' : '#114B86',
    // Réservé aux deux types d'alerte. L'étendre aux rappels apprendrait à
    // l'utilisateur à couper le canal — alerte comprise.
    bypassSilence: alerte,
  };
};

module.exports = {
  TRIP_ALERT_TYPES,
  TRIP_OWNER_TYPES,
  TRIP_TYPES,
  CANAL_ALERTE,
  CANAL_TRAJET,
  isTripType,
  isTripAlert,
  resolveTripPush,
};
