const crypto = require('crypto');

const PREFIX = '[NotifTrace]';

/**
 * Hash court pour logs (deviceId / token) — jamais le secret complet.
 * @param {string} value
 * @returns {string}
 */
const hashForLog = (value) => {
  if (!value || typeof value !== 'string') return '';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
};

/**
 * Tronque un corps de message pour les logs (max 32 chars).
 * @param {string} body
 * @returns {string}
 */
const previewForLog = (body) => {
  if (!body || typeof body !== 'string') return '';
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 32) return trimmed;
  return `${trimmed.slice(0, 29)}...`;
};

/**
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
const logNotificationEvent = (event, fields = {}) => {
  const payload = {
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  // Ne jamais inclure token/body complet — champs autorisés uniquement
  const safe = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'fcmToken' || k === 'token' || k === 'voipToken') {
      safe[k] = hashForLog(String(v));
      continue;
    }
    if (k === 'body' || k === 'content') {
      safe.bodyPreview = previewForLog(String(v));
      continue;
    }
    safe[k] = v;
  }
  console.log(`${PREFIX} ${JSON.stringify(safe)}`);
};

const logQueued = (fields) => logNotificationEvent('notification_queued', fields);
const logSkipped = (fields) => logNotificationEvent('notification_skipped', fields);
const logSent = (fields) => logNotificationEvent('notification_sent', fields);
const logFailed = (fields) => logNotificationEvent('notification_failed', fields);
const logTokenStale = (fields) => logNotificationEvent('notification_token_stale', fields);

module.exports = {
  hashForLog,
  previewForLog,
  logNotificationEvent,
  logQueued,
  logSkipped,
  logSent,
  logFailed,
  logTokenStale,
};
