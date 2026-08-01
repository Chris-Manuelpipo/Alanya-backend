const {
  VISIBILITY_VALUES,
  PREVIEW_VALUES,
  loadUserPrivacyPrefs,
  upsertUserPrivacyPrefs,
} = require('../services/privacyPrefsService');

const _toBool = (v) => v === true || v === 1 || v === '1';

const _formatPrefs = (row) => ({
  lastSeenVisibility: row.lastSeenVisibility || 'everyone',
  onlineVisibility: row.onlineVisibility || 'everyone',
  readReceiptsEnabled: _toBool(row.readReceiptsEnabled),
  profilePhotoVisibility: row.profilePhotoVisibility || 'everyone',
  addMePolicy: row.addMePolicy || 'everyone',
  previewMode: row.previewMode || 'full',
});

const _normalizePatch = (body = {}) => {
  const patch = {};
  const visibilityFields = [
    'lastSeenVisibility',
    'onlineVisibility',
    'profilePhotoVisibility',
    'addMePolicy',
  ];
  for (const key of visibilityFields) {
    if (body[key] !== undefined) {
      const value = String(body[key]);
      if (VISIBILITY_VALUES.has(value)) patch[key] = value;
    }
  }
  if (body.readReceiptsEnabled !== undefined) {
    patch.readReceiptsEnabled = _toBool(body.readReceiptsEnabled) ? 1 : 0;
  }
  if (body.previewMode !== undefined) {
    const mode = String(body.previewMode);
    if (PREVIEW_VALUES.has(mode)) patch.previewMode = mode;
  }
  return patch;
};

const getPrivacyPrefs = async (req, res) => {
  try {
    const prefs = await loadUserPrivacyPrefs(req.user.alanyaID);
    res.json(_formatPrefs(prefs));
  } catch (error) {
    console.error('[PrivacyPrefs] get error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const patchPrivacyPrefs = async (req, res) => {
  try {
    const patch = _normalizePatch(req.body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Aucune préférence valide fournie' });
    }
    const next = await upsertUserPrivacyPrefs(req.user.alanyaID, patch);
    res.json(_formatPrefs(next));
  } catch (error) {
    console.error('[PrivacyPrefs] patch error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getPrivacyPrefs,
  patchPrivacyPrefs,
};
