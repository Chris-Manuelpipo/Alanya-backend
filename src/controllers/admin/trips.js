/**
 * Compteurs agrégés des trajets de confiance.
 *
 * ⚠ Cette route ne doit JAMAIS renvoyer d'identité ni de coordonnée.
 * Interdit : owner_id, alanyaID, dest_*, last_lat/lng, trip_point,
 * trip_watcher, client_id, owner_device, trip.id.
 * La table `trip` seule, en COUNT / AVG / GROUP BY date|kind|close_reason.
 *
 * `daysAgoIso` / `toNum` sont locaux (pas `./helpers`) pour ne pas tirer
 * `mailService` dans les tests one-shot.
 */

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function toNum(v) {
  return Number(v) || 0;
}

const OPEN_STATES = "('active','awaiting_confirm','alert','sos')";

function percentile(values, p) {
  const sorted = values
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sorted[lo]);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function round1(n) {
  return Math.round(toNum(n) * 10) / 10;
}

function ratePct(numerator, den) {
  if (!toNum(den)) return 0;
  return round1((toNum(numerator) / toNum(den)) * 100);
}

function sqlDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function normalizeKind(kind) {
  if (kind === 'sos') return 'sos';
  if (kind === 'walk' || kind === 'meeting') return 'walk';
  return 'taxi';
}

function isMissingTripTable(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)
    && msg.toLowerCase().includes('trip');
}

async function fetchTripStats(fromInput, toInput, db) {
  const exec = db || require('../../config/db');
  const from = fromInput || daysAgoIso(7);
  const to = toInput || new Date().toISOString();

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const spanMs = Math.max(0, toMs - fromMs);
  const prevFrom = new Date(fromMs - spanMs).toISOString();
  const prevTo = from;

  const [
    [[openRow]],
    [[startedRow]],
    [[startedPrevRow]],
    [startedByDay],
    [byKindRows],
    [[closedRow]],
    [byReasonRows],
    [durationRows],
    [resolveDelayRows],
  ] = await Promise.all([
    // Snapshot hors période : combien de partages sont ouverts maintenant.
    exec.execute(
      `SELECT COUNT(*) AS n FROM trip WHERE state IN ${OPEN_STATES}`,
    ),
    exec.execute(
      `SELECT
         COUNT(*) AS started,
         COALESCE(SUM(state = 'closed_confirmed'), 0) AS confirmed,
         COALESCE(SUM(alerted_at IS NOT NULL), 0) AS alerted,
         COALESCE(SUM(kind = 'sos' OR close_reason = 'sos'), 0) AS sos
       FROM trip WHERE started_at BETWEEN ? AND ?`,
      [from, to],
    ),
    exec.execute(
      `SELECT COUNT(*) AS n FROM trip WHERE started_at BETWEEN ? AND ?`,
      [prevFrom, prevTo],
    ),
    exec.execute(
      `SELECT DATE(started_at) AS date, COUNT(*) AS count
         FROM trip WHERE started_at BETWEEN ? AND ?
         GROUP BY DATE(started_at) ORDER BY date ASC`,
      [from, to],
    ),
    exec.execute(
      `SELECT
         CASE
           WHEN kind IN ('walk', 'meeting') THEN 'walk'
           WHEN kind = 'sos' THEN 'sos'
           ELSE 'taxi'
         END AS k,
         COUNT(*) AS n
       FROM trip WHERE started_at BETWEEN ? AND ?
       GROUP BY k`,
      [from, to],
    ),
    exec.execute(
      `SELECT
         COUNT(*) AS closed,
         COALESCE(AVG(extensions), 0) AS avgExtensions,
         COALESCE(SUM(alerted_at IS NOT NULL), 0) AS alertedClosed,
         COALESCE(SUM(alerted_at IS NOT NULL
                      AND close_reason IN ('false_alarm', 'confirmed_after_alert')), 0)
           AS alertsResolved
       FROM trip WHERE closed_at BETWEEN ? AND ?`,
      [from, to],
    ),
    exec.execute(
      `SELECT COALESCE(close_reason, 'unknown') AS reason, COUNT(*) AS n
         FROM trip WHERE closed_at BETWEEN ? AND ?
         GROUP BY close_reason ORDER BY n DESC`,
      [from, to],
    ),
    exec.execute(
      `SELECT TIMESTAMPDIFF(SECOND, started_at, closed_at) AS sec
         FROM trip
        WHERE closed_at BETWEEN ? AND ?
          AND started_at IS NOT NULL
          AND closed_at IS NOT NULL`,
      [from, to],
    ),
    exec.execute(
      `SELECT TIMESTAMPDIFF(SECOND, alerted_at, closed_at) AS sec
         FROM trip
        WHERE closed_at BETWEEN ? AND ?
          AND alerted_at IS NOT NULL
          AND close_reason IN ('false_alarm', 'confirmed_after_alert')`,
      [from, to],
    ),
  ]);

  const started = toNum(startedRow?.started);
  const confirmed = toNum(startedRow?.confirmed);
  const alerted = toNum(startedRow?.alerted);
  const sos = toNum(startedRow?.sos);
  const durations = (durationRows || []).map((r) => toNum(r.sec));
  const resolveDelays = (resolveDelayRows || []).map((r) => toNum(r.sec));

  return {
    openNow: toNum(openRow?.n),
    started,
    startedPrevious: toNum(startedPrevRow?.n),
    startedByDay: (startedByDay || []).map((r) => ({
      date: sqlDate(r.date),
      count: toNum(r.count),
    })),
    confirmed,
    confirmedRate: ratePct(confirmed, started),
    alerted,
    alertedRate: ratePct(alerted, started),
    sos,
    closed: toNum(closedRow?.closed),
    durationMedianSec: percentile(durations, 0.5),
    durationP90Sec: percentile(durations, 0.9),
    avgExtensions: round1(closedRow?.avgExtensions),
    alertsClosed: toNum(closedRow?.alertedClosed),
    alertsResolved: toNum(closedRow?.alertsResolved),
    alertsResolvedMedianSec: percentile(resolveDelays, 0.5),
    byKind: (byKindRows || []).map((r) => ({
      kind: normalizeKind(r.k),
      count: toNum(r.n),
    })),
    byCloseReason: (byReasonRows || []).map((r) => ({
      reason: r.reason == null ? 'unknown' : String(r.reason),
      count: toNum(r.n),
    })),
    period: { from, to },
    previousPeriod: { from: prevFrom, to: prevTo },
  };
}

const getTripStats = async (req, res) => {
  try {
    const data = await fetchTripStats(req.query.from, req.query.to);
    res.json(data);
  } catch (error) {
    if (isMissingTripTable(error)) {
      console.error('[Admin] getTripStats: table trip absente');
      return res.status(500).json({ error: 'Erreur serveur' });
    }
    console.error('[Admin] getTripStats error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  getTripStats,
  fetchTripStats,
  percentile,
  normalizeKind,
  isMissingTripTable,
};
