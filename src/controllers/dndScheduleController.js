const {
  loadUserDndSchedule,
  upsertUserDndSchedule,
  _formatTime,
} = require('../services/dndScheduleService');

const _toBool = (v) => v === true || v === 1 || v === '1';

const _formatSchedule = (row) => ({
  enabled: _toBool(row.enabled),
  startTime: _formatTime(row.startTime) || '22:00',
  endTime: _formatTime(row.endTime) || '07:00',
  daysBitmask: Number(row.daysBitmask ?? 127),
});

const _normalizePatch = (body = {}) => {
  const patch = {};
  if (body.enabled !== undefined) {
    patch.enabled = _toBool(body.enabled) ? 1 : 0;
  }
  if (body.startTime !== undefined) patch.startTime = body.startTime;
  if (body.endTime !== undefined) patch.endTime = body.endTime;
  if (body.daysBitmask !== undefined) patch.daysBitmask = body.daysBitmask;
  return patch;
};

const getDndSchedule = async (req, res) => {
  try {
    const schedule = await loadUserDndSchedule(req.user.alanyaID);
    res.json(_formatSchedule(schedule));
  } catch (error) {
    console.error('[DndSchedule] get error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const patchDndSchedule = async (req, res) => {
  try {
    const patch = _normalizePatch(req.body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Aucun paramètre valide fourni' });
    }
    const next = await upsertUserDndSchedule(req.user.alanyaID, patch);
    res.json(_formatSchedule(next));
  } catch (error) {
    const status = /invalide|doit être/i.test(error.message) ? 400 : 500;
    console.error('[DndSchedule] patch error:', error.message);
    res.status(status).json({ error: error.message });
  }
};

module.exports = {
  getDndSchedule,
  patchDndSchedule,
};
