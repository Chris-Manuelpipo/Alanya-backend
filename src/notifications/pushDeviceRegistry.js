const pool = require('../config/db');
const { hashForLog } = require('../notifications/notificationLogger');

const HEARTBEAT_FRESH_MS = Number(process.env.PUSH_HEARTBEAT_FRESH_MS || 90_000);

/**
 * @param {number} alanyaID
 * @returns {Promise<Array<{deviceId:string,fcmToken:string|null,platform:string,appState:string,activeConversationId:number|null,lastHeartbeatAt:Date|null,notificationsEnabled:number}>>}
 */
const loadUserPushDevices = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      `SELECT deviceId, fcmToken, platform, appState, activeConversationId,
              lastHeartbeatAt, notificationsEnabled
       FROM user_push_devices
       WHERE alanyaID = ? AND notificationsEnabled = 1`,
      [alanyaID],
    );
    return rows;
  } catch (e) {
    // Table absente avant migration — fallback silencieux
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
};

/**
 * True si l'appareil est foreground sur la conversation avec heartbeat récent.
 */
const shouldSkipDeviceForMessage = (device, conversationId) => {
  if (!device || !conversationId) return false;
  if (device.appState !== 'foreground') return false;
  if (Number(device.activeConversationId) !== Number(conversationId)) return false;
  if (!device.lastHeartbeatAt) return false;
  const age = Date.now() - new Date(device.lastHeartbeatAt).getTime();
  return age <= HEARTBEAT_FRESH_MS;
};

/**
 * Fallback legacy users.fcm_token si aucun appareil enregistré.
 */
const loadLegacyToken = async (alanyaID) => {
  const [rows] = await pool.execute(
    'SELECT fcm_token, device_ID FROM users WHERE alanyaID = ? AND fcm_token != "INDEFINI"',
    [alanyaID],
  );
  if (rows.length === 0) return null;
  return {
    deviceId: String(rows[0].device_ID || 'legacy'),
    fcmToken: rows[0].fcm_token,
    platform: 'unknown',
    appState: 'unknown',
    activeConversationId: null,
    lastHeartbeatAt: null,
    notificationsEnabled: 1,
    legacy: true,
  };
};

/**
 * Liste les cibles push éligibles pour un utilisateur et un message.
 * @param {number} alanyaID
 * @param {number|string} conversationId
 */
const resolvePushTargets = async (alanyaID, conversationId) => {
  let devices = await loadUserPushDevices(alanyaID);
  if (devices.length === 0) {
    const legacy = await loadLegacyToken(alanyaID);
    return legacy ? [legacy] : [];
  }

  const targets = [];
  for (const d of devices) {
    if (!d.fcmToken || d.fcmToken === 'INDEFINI') continue;
    if (shouldSkipDeviceForMessage(d, conversationId)) {
      console.log(
        `[PushDevice] skip user=${alanyaID} device=${hashForLog(d.deviceId)} reason=active_conversation`,
      );
      continue;
    }
    targets.push(d);
  }
  return targets;
};

module.exports = {
  HEARTBEAT_FRESH_MS,
  loadUserPushDevices,
  shouldSkipDeviceForMessage,
  loadLegacyToken,
  resolvePushTargets,
};
