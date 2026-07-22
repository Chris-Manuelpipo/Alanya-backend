const crypto = require('crypto');

/** @typedef {'message'|'message_read_sync'|'call'|'group_call'|'call_ended'|'meeting_invite'|'meeting_reminder'|'status_view'} NotificationType */

const SCHEMA_VERSION = '2';

const NOTIFICATION_TYPES = Object.freeze([
  'message',
  'message_read_sync',
  'call',
  'group_call',
  'call_ended',
  'meeting_invite',
  'meeting_reminder',
  'status_view',
]);

/**
 * Génère un eventId unique pour tracer un envoi de notification.
 * @returns {string}
 */
const generateEventId = () => `notif_${crypto.randomUUID()}`;

/**
 * Convertit un objet payload en map FCM data (toutes les valeurs en string).
 * @param {Record<string, unknown>} data
 * @returns {Record<string, string>}
 */
const stringifyData = (data = {}) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );

/**
 * @param {unknown} value
 * @returns {string}
 */
const asString = (value) => (value == null ? '' : String(value));

/**
 * Construit le payload v2 pour une notification message.
 * Rétrocompatible : les champs legacy (title, body, callerId) sont conservés.
 *
 * @param {object} input
 * @param {number|string} input.msgID
 * @param {number|string} input.conversationId
 * @param {number|string} input.senderId
 * @param {string} input.senderName
 * @param {string} [input.senderAvatar]
 * @param {string} input.body
 * @param {number|string} [input.msgType]
 * @param {boolean} [input.isGroup]
 * @param {string} [input.groupName]
 * @param {string} [input.groupAvatar]
 * @param {string} [input.clientId]
 * @param {string|Date} [input.sentAt]
 * @param {number|string} [input.unreadTotal]
 * @param {string} [input.eventId]
 * @returns {Record<string, string>}
 */
const buildMessagePayload = (input = {}) => {
  const eventId = input.eventId || generateEventId();
  const isGroup = input.isGroup === true || input.isGroup === 1 || input.isGroup === '1';
  const groupName = asString(input.groupName);
  const senderName = asString(input.senderName);
  const body = asString(input.body);
  const sentAt =
    input.sentAt instanceof Date
      ? input.sentAt.toISOString()
      : asString(input.sentAt) || new Date().toISOString();

  const title = isGroup && groupName ? groupName : senderName;

  return stringifyData({
    schemaVersion: SCHEMA_VERSION,
    eventId,
    type: 'message',
    msgID: input.msgID,
    clientId: input.clientId ?? '',
    conversationId: input.conversationId,
    senderId: input.senderId,
    senderName,
    senderAvatar: input.senderAvatar ?? '',
    title,
    body: isGroup && senderName ? `${senderName}: ${body}` : body,
    msgType: input.msgType ?? 0,
    isGroup: isGroup ? '1' : '0',
    groupName,
    groupAvatar: input.groupAvatar ?? '',
    sentAt,
    unreadTotal: input.unreadTotal ?? '',
    // Legacy aliases consumed by le client actuel
    callerId: input.senderId,
  });
};

/**
 * Payload silencieux pour synchroniser la lecture sur les autres appareils.
 * @param {object} input
 * @param {number|string} input.conversationId
 * @param {number|string} [input.msgID]
 * @param {string} [input.eventId]
 * @returns {Record<string, string>}
 */
const buildMessageReadSyncPayload = (input = {}) =>
  stringifyData({
    schemaVersion: SCHEMA_VERSION,
    eventId: input.eventId || generateEventId(),
    type: 'message_read_sync',
    conversationId: input.conversationId,
    msgID: input.msgID ?? '',
  });

/**
 * Normalise un payload entrant (legacy ou v2) sans lever d'exception.
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {Record<string, string>}
 */
const normalizeIncomingPayload = (raw = {}) => {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const type = asString(safe.type) || 'message';
  const normalized = stringifyData({ ...safe, type });

  if (!normalized.schemaVersion) {
    normalized.schemaVersion = '1';
  }
  if (!normalized.eventId && normalized.msgID) {
    normalized.eventId = `legacy_msg_${normalized.msgID}`;
  }
  return normalized;
};

/**
 * @param {Record<string, string>} data
 * @returns {boolean}
 */
const isV2Payload = (data) => asString(data?.schemaVersion) === SCHEMA_VERSION;

module.exports = {
  SCHEMA_VERSION,
  NOTIFICATION_TYPES,
  generateEventId,
  stringifyData,
  buildMessagePayload,
  buildMessageReadSyncPayload,
  normalizeIncomingPayload,
  isV2Payload,
};
