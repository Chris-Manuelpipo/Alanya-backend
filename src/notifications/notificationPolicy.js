/**
 * Politiques d'envoi push — centralisées pour tests et feature flags futurs.
 */

/** Messages : toujours FCM (Phase 1.1). Le client supprime si conversation active. */
const getMessagePushOptions = () => ({});

/** Appels : pas de skip socket (comportement historique). */
const getCallPushOptions = () => ({});

/** Réunions / statuts : pas de skip socket. */
const getVisiblePushOptions = () => ({});

module.exports = {
  getMessagePushOptions,
  getCallPushOptions,
  getVisiblePushOptions,
};
