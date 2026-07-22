const pool = require('../config/db');

const DEFAULT_PREFS = Object.freeze({
  messagesEnabled: 1,
  groupMessagesEnabled: 1,
  callsEnabled: 1,
  meetingsEnabled: 1,
  statusViewEnabled: 0,
  soundEnabled: 1,
  vibrationEnabled: 1,
  previewMode: 'full',
});

const loadUserNotificationPrefs = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_notification_prefs WHERE alanyaID = ?',
      [alanyaID],
    );
    if (rows.length === 0) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...rows[0] };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULT_PREFS };
    throw e;
  }
};

const upsertUserNotificationPrefs = async (alanyaID, patch = {}) => {
  const current = await loadUserNotificationPrefs(alanyaID);
  const next = { ...current, ...patch };
  await pool.execute(
    `INSERT INTO user_notification_prefs
       (alanyaID, messagesEnabled, groupMessagesEnabled, callsEnabled, meetingsEnabled,
        statusViewEnabled, soundEnabled, vibrationEnabled, previewMode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       messagesEnabled = VALUES(messagesEnabled),
       groupMessagesEnabled = VALUES(groupMessagesEnabled),
       callsEnabled = VALUES(callsEnabled),
       meetingsEnabled = VALUES(meetingsEnabled),
       statusViewEnabled = VALUES(statusViewEnabled),
       soundEnabled = VALUES(soundEnabled),
       vibrationEnabled = VALUES(vibrationEnabled),
       previewMode = VALUES(previewMode),
       updatedAt = NOW()`,
    [
      alanyaID,
      next.messagesEnabled ? 1 : 0,
      next.groupMessagesEnabled ? 1 : 0,
      next.callsEnabled ? 1 : 0,
      next.meetingsEnabled ? 1 : 0,
      next.statusViewEnabled ? 1 : 0,
      next.soundEnabled ? 1 : 0,
      next.vibrationEnabled ? 1 : 0,
      next.previewMode || 'full',
    ],
  );
  return next;
};

const loadConversationMute = async (conversationId, alanyaID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT mutedUntil, muteForever, mentionsOnly FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversationId, alanyaID],
    );
    return rows[0] || { mutedUntil: null, muteForever: 0, mentionsOnly: 0 };
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      return { mutedUntil: null, muteForever: 0, mentionsOnly: 0 };
    }
    throw e;
  }
};

const isConversationMuted = (muteRow) => {
  if (muteRow?.muteForever) return true;
  if (!muteRow?.mutedUntil) return false;
  return new Date(muteRow.mutedUntil).getTime() > Date.now();
};

/**
 * Applique previewMode au corps/titre push.
 */
const applyPreviewPolicy = (prefs, { title, body, senderName, isGroup }) => {
  const mode = prefs.previewMode || 'full';
  if (mode === 'full') return { title, body };
  if (mode === 'name_only') {
    return {
      title: isGroup ? title : senderName || title,
      body: 'Nouveau message',
    };
  }
  return { title: 'Alanya', body: 'Nouveau message' };
};

module.exports = {
  DEFAULT_PREFS,
  loadUserNotificationPrefs,
  upsertUserNotificationPrefs,
  loadConversationMute,
  isConversationMuted,
  applyPreviewPolicy,
};
