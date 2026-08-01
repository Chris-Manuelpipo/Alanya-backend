const pool = require('../config/db');

const DEFAULT_DND = Object.freeze({
  enabled: 0,
  startTime: '22:00:00',
  endTime: '07:00:00',
  daysBitmask: 127,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const _normalizeTime = (value, fallback) => {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim();
  const match = raw.match(TIME_RE);
  if (!match) return null;
  const seconds = match[3] != null ? match[3] : '00';
  return `${match[1]}:${match[2]}:${seconds}`;
};

const _formatTime = (value) => {
  if (value == null) return null;
  const raw = String(value);
  return raw.length >= 5 ? raw.slice(0, 5) : raw;
};

const loadUserDndSchedule = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_dnd_schedule WHERE alanyaID = ?',
      [alanyaID],
    );
    if (rows.length === 0) return { ...DEFAULT_DND };
    return { ...DEFAULT_DND, ...rows[0] };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULT_DND };
    throw e;
  }
};

const upsertUserDndSchedule = async (alanyaID, patch = {}) => {
  const current = await loadUserDndSchedule(alanyaID);
  const next = { ...current, ...patch };

  const startTime = _normalizeTime(next.startTime, DEFAULT_DND.startTime);
  const endTime = _normalizeTime(next.endTime, DEFAULT_DND.endTime);
  if (startTime == null || endTime == null) {
    throw new Error('Format horaire invalide (attendu HH:MM ou HH:MM:SS)');
  }

  let daysBitmask = Number(next.daysBitmask);
  if (!Number.isInteger(daysBitmask) || daysBitmask < 0 || daysBitmask > 127) {
    throw new Error('daysBitmask doit être un entier entre 0 et 127');
  }

  await pool.execute(
    `INSERT INTO user_dnd_schedule
       (alanyaID, enabled, startTime, endTime, daysBitmask)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       startTime = VALUES(startTime),
       endTime = VALUES(endTime),
       daysBitmask = VALUES(daysBitmask),
       updatedAt = NOW()`,
    [
      alanyaID,
      next.enabled ? 1 : 0,
      startTime,
      endTime,
      daysBitmask,
    ],
  );

  return {
    enabled: next.enabled ? 1 : 0,
    startTime,
    endTime,
    daysBitmask,
  };
};

/** bit0=lundi … bit6=dimanche (cf. migration 033) */
const _mondayBasedDayBit = (date) => {
  const jsDay = date.getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
};

const _timeToMinutes = (value) => {
  const raw = String(value || '');
  const parts = raw.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
};

/**
 * Vrai si le créneau Ne pas déranger est actif à l'instant donné.
 */
const isDndActive = (schedule, now = new Date()) => {
  if (!schedule?.enabled) return false;

  const bit = _mondayBasedDayBit(now);
  const mask = Number(schedule.daysBitmask);
  if (!Number.isInteger(mask) || (mask & (1 << bit)) === 0) return false;

  const start = _timeToMinutes(schedule.startTime);
  const end = _timeToMinutes(schedule.endTime);
  const current = now.getHours() * 60 + now.getMinutes();

  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
};

module.exports = {
  DEFAULT_DND,
  loadUserDndSchedule,
  upsertUserDndSchedule,
  isDndActive,
  _formatTime,
  _normalizeTime,
  _mondayBasedDayBit,
  _timeToMinutes,
};
