const {
  VALID_THEME_MODES,
  loadUserAppSettings,
  upsertUserAppSettings,
  _clampSpeed,
  _clampFontScale,
} = require('../services/appSettingsService');

const _toBool = (v) => v === true || v === 1 || v === '1';

const _formatSettings = (row) => ({
  themeMode: row.themeMode || 'system',
  locale: row.locale || 'fr',
  playbackSpeedVoice: Number(row.playbackSpeedVoice ?? 1),
  playbackSpeedVideo: Number(row.playbackSpeedVideo ?? 1),
  playbackSpeedMusic: Number(row.playbackSpeedMusic ?? 1),
  reduceMotion: _toBool(row.reduceMotion),
  fontScale: Number(row.fontScale ?? 1),
});

const _normalizePatch = (body = {}) => {
  const patch = {};
  if (body.themeMode !== undefined) {
    const mode = String(body.themeMode);
    if (VALID_THEME_MODES.has(mode)) patch.themeMode = mode;
  }
  if (body.locale !== undefined) {
    const locale = String(body.locale).trim();
    if (locale.length > 0 && locale.length <= 16) patch.locale = locale;
  }
  if (body.playbackSpeedVoice !== undefined) {
    patch.playbackSpeedVoice = _clampSpeed(body.playbackSpeedVoice);
  }
  if (body.playbackSpeedVideo !== undefined) {
    patch.playbackSpeedVideo = _clampSpeed(body.playbackSpeedVideo);
  }
  if (body.playbackSpeedMusic !== undefined) {
    patch.playbackSpeedMusic = _clampSpeed(body.playbackSpeedMusic);
  }
  if (body.reduceMotion !== undefined) {
    patch.reduceMotion = _toBool(body.reduceMotion) ? 1 : 0;
  }
  if (body.fontScale !== undefined) {
    patch.fontScale = _clampFontScale(body.fontScale);
  }
  return patch;
};

const getAppSettings = async (req, res) => {
  try {
    const settings = await loadUserAppSettings(req.user.alanyaID);
    res.json(_formatSettings(settings));
  } catch (error) {
    console.error('[AppSettings] get error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const patchAppSettings = async (req, res) => {
  try {
    const patch = _normalizePatch(req.body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Aucun paramètre valide fourni' });
    }
    const next = await upsertUserAppSettings(req.user.alanyaID, patch);
    res.json(_formatSettings(next));
  } catch (error) {
    console.error('[AppSettings] patch error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getAppSettings,
  patchAppSettings,
};
