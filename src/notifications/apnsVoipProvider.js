const fs = require('fs');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const {
  logSent,
  logFailed,
  logTokenStale,
  hashForLog,
} = require('./notificationLogger');

const VOIP_TTL_SEC = Number(process.env.APNS_VOIP_TTL_SEC || 60);

let cachedAuthToken = null;
let cachedAuthExpiresAt = 0;

const isConfigured = () =>
  Boolean(
    process.env.APNS_KEY_ID &&
      process.env.APNS_TEAM_ID &&
      (process.env.APNS_KEY_P8 || process.env.APNS_KEY_PATH) &&
      process.env.APNS_BUNDLE_ID,
  );

const readSigningKey = () => {
  if (process.env.APNS_KEY_P8) {
    return process.env.APNS_KEY_P8.replace(/\\n/g, '\n');
  }
  if (process.env.APNS_KEY_PATH) {
    return fs.readFileSync(process.env.APNS_KEY_PATH, 'utf8');
  }
  return null;
};

const getAuthToken = () => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAuthToken && cachedAuthExpiresAt - 120 > now) {
    return cachedAuthToken;
  }
  const key = readSigningKey();
  if (!key) throw new Error('APNS signing key missing');
  cachedAuthToken = jwt.sign({}, key, {
    algorithm: 'ES256',
    keyid: process.env.APNS_KEY_ID,
    issuer: process.env.APNS_TEAM_ID,
    expiresIn: '50m',
  });
  cachedAuthExpiresAt = now + 50 * 60;
  return cachedAuthToken;
};

const apnsHost = () =>
  process.env.APNS_PRODUCTION === 'true' || process.env.APNS_PRODUCTION === '1'
    ? 'api.push.apple.com'
    : 'api.development.push.apple.com';

/**
 * Payload VoIP compatible flutter_callkit_incoming (AppDelegate Phase 6).
 */
const buildVoipCallPayload = (data = {}) => {
  const callId = String(data.callId || data.roomId || '');
  const roomId = String(data.roomId || '');
  const callerId = String(data.callerId || '');
  const callerName = String(data.callerName || data.title || 'Appel entrant');
  const photo = String(data.photo || '');
  const isVideo = String(data.isVideo ?? 'false');
  const id = callId || roomId;

  return {
    id,
    callId: id,
    callerId,
    callerName,
    photo,
    isVideo,
    roomId,
    type: String(data.type || 'call'),
  };
};

const sendVoipPush = (voipToken, data = {}, meta = {}) =>
  new Promise((resolve) => {
    if (!isConfigured()) {
      resolve({ ok: false, reason: 'not_configured' });
      return;
    }
    const token = String(voipToken || '').trim();
    if (!token) {
      resolve({ ok: false, reason: 'empty_token' });
      return;
    }

    const bundleId = String(process.env.APNS_BUNDLE_ID).trim();
    const payload = buildVoipCallPayload(data);
    const body = JSON.stringify(payload);
    const auth = getAuthToken();
    const client = http2.connect(`https://${apnsHost()}`);

    client.on('error', (err) => {
      logFailed({
        type: data.type,
        reason: `apns_voip_connect:${err.message}`,
      });
      resolve({ ok: false, reason: err.message });
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${auth}`,
      'apns-topic': `${bundleId}.voip`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + VOIP_TTL_SEC),
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });

    let responseBody = '';
    req.on('response', (headers) => {
      const status = headers[':status'];
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', () => {
        client.close();
        if (status === 200) {
          logSent({
            type: data.type,
            providerMessageId: headers['apns-id'],
            deviceId: hashForLog(meta.deviceId || token),
          });
          resolve({ ok: true, apnsId: headers['apns-id'] });
          return;
        }

        const stale =
          status === 410 ||
          (responseBody && /BadDeviceToken|Unregistered|ExpiredToken/i.test(responseBody));
        if (stale) {
          logTokenStale({
            type: data.type,
            reason: `apns_voip_${status}`,
            deviceId: hashForLog(meta.deviceId || token),
          });
          resolve({ ok: false, reason: 'stale_token', status });
          return;
        }

        logFailed({
          type: data.type,
          reason: `apns_voip_${status}:${responseBody || 'unknown'}`,
        });
        resolve({ ok: false, reason: responseBody || String(status), status });
      });
    });

    req.on('error', (err) => {
      client.close();
      logFailed({ type: data.type, reason: `apns_voip:${err.message}` });
      resolve({ ok: false, reason: err.message });
    });

    req.write(body);
    req.end();
  });

const clearVoipToken = async (alanyaID, deviceId) => {
  try {
    const pool = require('../config/db');
    await pool.execute(
      'UPDATE user_push_devices SET voipToken = NULL, updatedAt = NOW() WHERE alanyaID = ? AND deviceId = ?',
      [alanyaID, deviceId],
    );
  } catch (e) {
    console.warn('[APNS VoIP] clear token failed:', e.message);
  }
};

module.exports = {
  isConfigured,
  buildVoipCallPayload,
  sendVoipPush,
  clearVoipToken,
  apnsHost,
};
