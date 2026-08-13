const pool = require('../config/db');

const DEFAULT_PREFS = Object.freeze({
  messagesEnabled: 1,
  groupMessagesEnabled: 1,
  callsEnabled: 1,
  meetingsEnabled: 1,
  statusViewEnabled: 0,
  broadcastsEnabled: 1,
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

/**
 * Préférences de plusieurs utilisateurs en une seule requête.
 * @returns {Promise<Map<number, object>>} alanyaID → prefs (défauts si absent)
 */
const loadUserNotificationPrefsMany = async (alanyaIDs = []) => {
  const map = new Map();
  const ids = [...new Set(alanyaIDs.map(Number))].filter(Number.isInteger);
  for (const id of ids) map.set(id, { ...DEFAULT_PREFS });
  if (ids.length === 0) return map;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM user_notification_prefs WHERE alanyaID IN (?)',
      [ids],
    );
    for (const row of rows) {
      map.set(Number(row.alanyaID), { ...DEFAULT_PREFS, ...row });
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  return map;
};

const upsertUserNotificationPrefs = async (alanyaID, patch = {}) => {
  const current = await loadUserNotificationPrefs(alanyaID);
  const next = { ...current, ...patch };
  await pool.execute(
    `INSERT INTO user_notification_prefs
       (alanyaID, messagesEnabled, groupMessagesEnabled, callsEnabled, meetingsEnabled,
        statusViewEnabled, broadcastsEnabled, soundEnabled, vibrationEnabled, previewMode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       messagesEnabled = VALUES(messagesEnabled),
       groupMessagesEnabled = VALUES(groupMessagesEnabled),
       callsEnabled = VALUES(callsEnabled),
       meetingsEnabled = VALUES(meetingsEnabled),
       statusViewEnabled = VALUES(statusViewEnabled),
       broadcastsEnabled = VALUES(broadcastsEnabled),
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
      next.broadcastsEnabled != null ? (next.broadcastsEnabled ? 1 : 0) : 1,
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

const DEFAULT_MUTE = Object.freeze({ mutedUntil: null, muteForever: 0, mentionsOnly: 0 });

/**
 * Sourdines de plusieurs participants d'une conversation en une requête.
 * @returns {Promise<Map<number, object>>} alanyaID → ligne mute (défauts si absente)
 */
const loadConversationMuteMany = async (conversationId, alanyaIDs = []) => {
  const map = new Map();
  const ids = [...new Set(alanyaIDs.map(Number))].filter(Number.isInteger);
  for (const id of ids) map.set(id, { ...DEFAULT_MUTE });
  if (ids.length === 0) return map;
  try {
    const [rows] = await pool.query(
      'SELECT alanyaID, mutedUntil, muteForever, mentionsOnly FROM conv_participants WHERE conversID = ? AND alanyaID IN (?)',
      [conversationId, ids],
    );
    for (const row of rows) {
      map.set(Number(row.alanyaID), {
        mutedUntil: row.mutedUntil,
        muteForever: row.muteForever,
        mentionsOnly: row.mentionsOnly,
      });
    }
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  return map;
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
  loadUserNotificationPrefsMany,
  upsertUserNotificationPrefs,
  loadConversationMute,
  loadConversationMuteMany,
  isConversationMuted,
  applyPreviewPolicy,
};
