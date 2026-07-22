const {
  loadUserNotificationPrefs,
  upsertUserNotificationPrefs,
} = require('../notifications/notificationPrefs');

const VALID_PREVIEW = new Set(['full', 'name_only', 'generic']);

const _toBool = (v) => v === true || v === 1 || v === '1';

const _formatPrefs = (row) => ({
  messagesEnabled: _toBool(row.messagesEnabled),
  groupMessagesEnabled: _toBool(row.groupMessagesEnabled),
  callsEnabled: _toBool(row.callsEnabled),
  meetingsEnabled: _toBool(row.meetingsEnabled),
  statusViewEnabled: _toBool(row.statusViewEnabled),
  soundEnabled: _toBool(row.soundEnabled),
  vibrationEnabled: _toBool(row.vibrationEnabled),
  previewMode: row.previewMode || 'full',
});

const _normalizePatch = (body = {}) => {
  const patch = {};
  const boolFields = [
    'messagesEnabled',
    'groupMessagesEnabled',
    'callsEnabled',
    'meetingsEnabled',
    'statusViewEnabled',
    'soundEnabled',
    'vibrationEnabled',
  ];
  for (const key of boolFields) {
    if (body[key] !== undefined) patch[key] = _toBool(body[key]) ? 1 : 0;
  }
  if (body.previewMode !== undefined) {
    const mode = String(body.previewMode);
    if (VALID_PREVIEW.has(mode)) patch.previewMode = mode;
  }
  return patch;
};

const getNotificationPrefs = async (req, res) => {
  try {
    const prefs = await loadUserNotificationPrefs(req.user.alanyaID);
    res.json(_formatPrefs(prefs));
  } catch (error) {
    console.error('[NotificationPrefs] get error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const patchNotificationPrefs = async (req, res) => {
  try {
    const patch = _normalizePatch(req.body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Aucune préférence valide fournie' });
    }
    const next = await upsertUserNotificationPrefs(req.user.alanyaID, patch);
    res.json(_formatPrefs(next));
  } catch (error) {
    console.error('[NotificationPrefs] patch error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getNotificationPrefs,
  patchNotificationPrefs,
};
