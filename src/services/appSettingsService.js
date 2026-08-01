const pool = require('../config/db');
const { themeModeToInt, themeModeFromDb } = require('../constants/profilePrefs');

const VALID_THEME_MODES = new Set(['system', 'light', 'dark']);

const DEFAULT_SETTINGS = Object.freeze({
  themeMode: 'system',
  locale: 'fr',
  playbackSpeedVoice: 1.0,
  playbackSpeedVideo: 1.0,
  playbackSpeedMusic: 1.0,
  reduceMotion: 0,
  fontScale: 1.0,
});

const _clampSpeed = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.playbackSpeedVoice;
  return Math.min(3, Math.max(0.25, Math.round(n * 100) / 100));
};

const _clampFontScale = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.fontScale;
  return Math.min(2, Math.max(0.75, Math.round(n * 100) / 100));
};

const _normalizeRow = (row) => ({
  ...row,
  themeMode: themeModeFromDb(row.themeMode),
});

const loadUserAppSettings = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_settings WHERE alanyaID = ?',
      [alanyaID],
    );
    if (rows.length === 0) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ..._normalizeRow(rows[0]) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULT_SETTINGS };
    throw e;
  }
};

const upsertUserAppSettings = async (alanyaID, patch = {}) => {
  const current = await loadUserAppSettings(alanyaID);
  const next = { ...current, ...patch };
  await pool.execute(
    `INSERT INTO user_settings
       (alanyaID, themeMode, locale, playbackSpeedVoice, playbackSpeedVideo,
        playbackSpeedMusic, reduceMotion, fontScale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       themeMode = VALUES(themeMode),
       locale = VALUES(locale),
       playbackSpeedVoice = VALUES(playbackSpeedVoice),
       playbackSpeedVideo = VALUES(playbackSpeedVideo),
       playbackSpeedMusic = VALUES(playbackSpeedMusic),
       reduceMotion = VALUES(reduceMotion),
       fontScale = VALUES(fontScale),
       updatedAt = NOW()`,
    [
      alanyaID,
      themeModeToInt(next.themeMode),
      String(next.locale || 'fr').slice(0, 16),
      _clampSpeed(next.playbackSpeedVoice),
      _clampSpeed(next.playbackSpeedVideo),
      _clampSpeed(next.playbackSpeedMusic),
      next.reduceMotion ? 1 : 0,
      _clampFontScale(next.fontScale),
    ],
  );
  return {
    ...next,
    playbackSpeedVoice: _clampSpeed(next.playbackSpeedVoice),
    playbackSpeedVideo: _clampSpeed(next.playbackSpeedVideo),
    playbackSpeedMusic: _clampSpeed(next.playbackSpeedMusic),
    fontScale: _clampFontScale(next.fontScale),
    reduceMotion: next.reduceMotion ? 1 : 0,
  };
};

module.exports = {
  VALID_THEME_MODES,
  DEFAULT_SETTINGS,
  loadUserAppSettings,
  upsertUserAppSettings,
  _clampSpeed,
  _clampFontScale,
  _normalizeRow,
};
