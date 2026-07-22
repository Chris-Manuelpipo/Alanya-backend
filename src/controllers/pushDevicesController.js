const pool = require('../config/db');
const { hashForLog } = require('../notifications/notificationLogger');

const VALID_PLATFORMS = new Set(['android', 'ios', 'web', 'unknown']);
const VALID_APP_STATES = new Set(['foreground', 'background', 'unknown']);

const _normalizePlatform = (p) => {
  const v = String(p || 'unknown').toLowerCase();
  return VALID_PLATFORMS.has(v) ? v : 'unknown';
};

/**
 * Upsert appareil push pour l'utilisateur authentifié.
 */
const registerPushDevice = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const {
      deviceId,
      device_ID,
      platform,
      fcmToken,
      fcm_token,
      voipToken,
      locale,
    } = req.body;

    const devId = String(deviceId || device_ID || '').trim();
    const token = String(fcmToken || fcm_token || '').trim();
    if (!devId || devId.length > 128) {
      return res.status(400).json({ error: 'deviceId requis (max 128)' });
    }
    if (token && token.length > 4096) {
      return res.status(400).json({ error: 'fcmToken trop long' });
    }

    const plat = _normalizePlatform(platform);
    const voip = voipToken ? String(voipToken).slice(0, 2048) : null;

    await pool.execute(
      `INSERT INTO user_push_devices
         (alanyaID, deviceId, platform, fcmToken, voipToken, locale, tokenUpdatedAt, lastHeartbeatAt)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         platform = VALUES(platform),
         fcmToken = COALESCE(VALUES(fcmToken), fcmToken),
         voipToken = COALESCE(VALUES(voipToken), voipToken),
         locale = COALESCE(VALUES(locale), locale),
         tokenUpdatedAt = IF(VALUES(fcmToken) IS NOT NULL, NOW(), tokenUpdatedAt),
         lastHeartbeatAt = NOW(),
         updatedAt = NOW()`,
      [alanyaID, devId, plat, token || null, voip, locale || null],
    );

    // Fallback legacy — compatibilité anciens clients
    if (token) {
      await pool.execute(
        'UPDATE users SET fcm_token = ?, device_ID = ? WHERE alanyaID = ?',
        [token, devId, alanyaID],
      );
    }

    console.log(`[PushDevice] register user=${alanyaID} device=${hashForLog(devId)} platform=${plat}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[PushDevice] register error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Heartbeat état app (foreground/background, conversation active).
 */
const updatePushDeviceState = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const {
      deviceId,
      device_ID,
      appState,
      activeConversationId,
      notificationsEnabled,
    } = req.body;

    const devId = String(deviceId || device_ID || '').trim();
    if (!devId) {
      return res.status(400).json({ error: 'deviceId requis' });
    }

    const state = VALID_APP_STATES.has(appState) ? appState : 'unknown';
    const activeConv =
      activeConversationId != null && activeConversationId !== ''
        ? Number(activeConversationId)
        : null;

    const updates = ['appState = ?', 'lastHeartbeatAt = NOW()', 'updatedAt = NOW()'];
    const values = [state];

    if (activeConv != null && Number.isFinite(activeConv)) {
      updates.push('activeConversationId = ?');
      values.push(activeConv);
    } else if (activeConversationId === null || activeConversationId === 0 || activeConversationId === '0') {
      updates.push('activeConversationId = NULL');
    }

    if (typeof notificationsEnabled === 'boolean' || notificationsEnabled === 0 || notificationsEnabled === 1) {
      updates.push('notificationsEnabled = ?');
      values.push(notificationsEnabled === true || notificationsEnabled === 1 ? 1 : 0);
    }

    values.push(alanyaID, devId);
    const [result] = await pool.execute(
      `UPDATE user_push_devices SET ${updates.join(', ')}
       WHERE alanyaID = ? AND deviceId = ?`,
      values,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Appareil non enregistré' });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[PushDevice] state error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const deletePushDevice = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const devId = String(req.params.deviceId || '').trim();
    if (!devId) {
      return res.status(400).json({ error: 'deviceId requis' });
    }
    await pool.execute(
      'DELETE FROM user_push_devices WHERE alanyaID = ? AND deviceId = ?',
      [alanyaID, devId],
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('[PushDevice] delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  registerPushDevice,
  updatePushDeviceState,
  deletePushDevice,
};
