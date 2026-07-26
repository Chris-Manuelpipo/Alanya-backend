/**
 * Choix du chemin d'envoi : registre multi-appareil (`user_push_devices`) ou
 * chemin legacy (`users.fcm_token`, un seul appareil).
 *
 * Extrait de `sendToUser` pour être testable sans base : la condition portait
 * `data.type === 'message'` en dur, ce qui envoyait `message_read_sync` sur le
 * chemin legacy — donc vers UN seul appareil, alors que son unique raison
 * d'être est de faire disparaître la notification sur les AUTRES appareils du
 * compte. La sync de lecture était donc silencieusement mono-appareil.
 */

/** Types dont la diffusion est propre à une conversation et multi-appareil. */
const DEVICE_REGISTRY_TYPES = new Set(['message', 'message_read_sync']);

/**
 * @param {boolean} deviceRegistryEnabled  drapeau DEVICE_REGISTRY_V2
 * @param {{type?: string, conversationId?: unknown}} data  payload push
 */
function shouldUseDeviceRegistry(deviceRegistryEnabled, data = {}) {
  if (!deviceRegistryEnabled) return false;
  if (!DEVICE_REGISTRY_TYPES.has(data.type)) return false;
  // `conversationId` est requis : `resolvePushTargets` s'en sert pour écarter
  // les appareils ayant déjà cette conversation au premier plan.
  return data.conversationId !== undefined
    && data.conversationId !== null
    && String(data.conversationId) !== ''
    && String(data.conversationId) !== '0';
}

module.exports = { shouldUseDeviceRegistry, DEVICE_REGISTRY_TYPES };
