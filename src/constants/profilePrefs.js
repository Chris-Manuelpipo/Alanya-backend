/** Constantes entières pour les prefs profil (pas d'ENUM MySQL). */

const VISIBILITY = Object.freeze({
  everyone: 0,
  contacts: 1,
  nobody: 2,
});

const VISIBILITY_FROM_INT = Object.freeze({
  0: 'everyone',
  1: 'contacts',
  2: 'nobody',
});

const PREVIEW_MODE = Object.freeze({
  full: 0,
  name_only: 1,
  generic: 2,
});

const PREVIEW_MODE_FROM_INT = Object.freeze({
  0: 'full',
  1: 'name_only',
  2: 'generic',
});

/** Compat migration depuis user_notification_prefs (ENUM string). */
const PREVIEW_MODE_FROM_STRING = Object.freeze({
  full: 0,
  name_only: 1,
  generic: 2,
});

const THEME_MODE = Object.freeze({
  system: 0,
  light: 1,
  dark: 2,
});

const THEME_MODE_FROM_INT = Object.freeze({
  0: 'system',
  1: 'light',
  2: 'dark',
});

const EXPORT_JOB_STATUS = Object.freeze({
  pending: 0,
  processing: 1,
  ready: 2,
  failed: 3,
});

const EXPORT_JOB_STATUS_FROM_INT = Object.freeze({
  0: 'pending',
  1: 'processing',
  2: 'ready',
  3: 'failed',
});

const visibilityToInt = (value) => {
  if (typeof value === 'number' && VISIBILITY_FROM_INT[value]) return value;
  const key = String(value ?? 'everyone');
  return VISIBILITY[key] ?? VISIBILITY.everyone;
};

const visibilityFromDb = (value) => {
  if (typeof value === 'string' && VISIBILITY[value] !== undefined) return value;
  return VISIBILITY_FROM_INT[Number(value)] ?? 'everyone';
};

const previewModeToInt = (value) => {
  if (typeof value === 'number' && PREVIEW_MODE_FROM_INT[value] !== undefined) {
    return value;
  }
  const key = String(value ?? 'full');
  if (PREVIEW_MODE[key] !== undefined) return PREVIEW_MODE[key];
  if (PREVIEW_MODE_FROM_STRING[key] !== undefined) return PREVIEW_MODE_FROM_STRING[key];
  return PREVIEW_MODE.full;
};

const previewModeFromDb = (value) => {
  if (typeof value === 'string' && PREVIEW_MODE[value] !== undefined) return value;
  return PREVIEW_MODE_FROM_INT[Number(value)] ?? 'full';
};

const themeModeToInt = (value) => {
  if (typeof value === 'number' && THEME_MODE_FROM_INT[value] !== undefined) return value;
  const key = String(value ?? 'system');
  return THEME_MODE[key] ?? THEME_MODE.system;
};

const themeModeFromDb = (value) => {
  if (typeof value === 'string' && THEME_MODE[value] !== undefined) return value;
  return THEME_MODE_FROM_INT[Number(value)] ?? 'system';
};

const exportStatusToInt = (value) => {
  if (typeof value === 'number' && EXPORT_JOB_STATUS_FROM_INT[value] !== undefined) {
    return value;
  }
  const key = String(value ?? 'pending');
  return EXPORT_JOB_STATUS[key] ?? EXPORT_JOB_STATUS.pending;
};

const exportStatusFromDb = (value) => {
  if (typeof value === 'string' && EXPORT_JOB_STATUS[value] !== undefined) return value;
  return EXPORT_JOB_STATUS_FROM_INT[Number(value)] ?? 'pending';
};

module.exports = {
  VISIBILITY,
  VISIBILITY_FROM_INT,
  PREVIEW_MODE,
  PREVIEW_MODE_FROM_INT,
  PREVIEW_MODE_FROM_STRING,
  THEME_MODE,
  THEME_MODE_FROM_INT,
  EXPORT_JOB_STATUS,
  EXPORT_JOB_STATUS_FROM_INT,
  visibilityToInt,
  visibilityFromDb,
  previewModeToInt,
  previewModeFromDb,
  themeModeToInt,
  themeModeFromDb,
  exportStatusToInt,
  exportStatusFromDb,
};
