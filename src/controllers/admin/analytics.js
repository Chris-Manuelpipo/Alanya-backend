const pool = require('../../config/db');
const {
  _daysAgoIso,
  _num,
  _MESSAGE_TYPE_LABELS,
  _STATUS_TYPE_LABELS,
  _ROLE_LABELS,
} = require('./helpers');

// ── GET /api/admin/analytics?from=&to= ─────────────────────────────
// Agrégations avancées (messagerie, appels, stories, réunions, users…)
// Calque le pattern de getStats : Promise.all de sous-requêtes paramétrées.
const getAnalytics = async (req, res) => {
  try {
    const from = req.query.from || _daysAgoIso(7);
    const to   = req.query.to   || new Date().toISOString();

    // Période précédente de même durée → tendances (comparison)
    const fromMs = new Date(from).getTime();
    const toMs   = new Date(to).getTime();
    const spanMs = Math.max(0, toMs - fromMs);
    const prevFrom = new Date(fromMs - spanMs).toISOString();
    const prevTo   = from;

    const [
      [msgByType],
      [msgByDay],
      [[callAgg]],
      [callsByDay],
      [[storyAgg]],
      [storyByType],
      [[meetingAgg]],
      [usersByRole],
      [[userGrowth]],
      [devices],
      [[convAgg]],
      [heatmap],
      [[comparison]],
    ] = await Promise.all([
      pool.execute(
        `SELECT type, COUNT(*) AS n FROM message
         WHERE sendAt BETWEEN ? AND ? GROUP BY type ORDER BY type ASC`,
        [from, to]
      ),
      pool.execute(
        `SELECT DATE(sendAt) AS date, COUNT(*) AS count FROM message
         WHERE sendAt BETWEEN ? AND ? GROUP BY DATE(sendAt) ORDER BY date ASC`,
        [from, to]
      ),
      pool.execute(
        `SELECT
           COUNT(*)             AS total,
           SUM(type = 0)        AS audio,
           SUM(type = 1)        AS video,
           SUM(status = 1)      AS answered,
           SUM(status = 0)      AS missed,
           SUM(status = 2)      AS rejected,
           COALESCE(ROUND(AVG(CASE WHEN status = 1 THEN duree END)), 0) AS avgDuration,
           COALESCE(SUM(duree), 0) AS totalDuration
         FROM callHistory WHERE created_at BETWEEN ? AND ?`,
        [from, to]
      ),
      pool.execute(
        `SELECT DATE(created_at) AS date,
                SUM(type = 0) AS audio,
                SUM(type = 1) AS video
         FROM callHistory WHERE created_at BETWEEN ? AND ?
         GROUP BY DATE(created_at) ORDER BY date ASC`,
        [from, to]
      ),
      pool.execute(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(viewedBy), 0) AS totalViews,
                COALESCE(SUM(likedBy), 0)  AS totalLikes
         FROM statut WHERE createdAt BETWEEN ? AND ?`,
        [from, to]
      ),
      pool.execute(
        `SELECT type, COUNT(*) AS n FROM statut
         WHERE createdAt BETWEEN ? AND ? GROUP BY type ORDER BY type ASC`,
        [from, to]
      ),
      pool.execute(
        `SELECT
           COUNT(DISTINCT m.idMeeting) AS total,
           COALESCE(ROUND(AVG(m.duree)), 0) AS avgDuration,
           COALESCE(SUM(p.status = 1), 0) AS accepted,
           COALESCE(SUM(p.status = 2), 0) AS declined,
           COALESCE(SUM(p.status = 0), 0) AS invited
         FROM meeting m
         LEFT JOIN participant p ON p.idMeeting = m.idMeeting
         WHERE m.start_time BETWEEN ? AND ?`,
        [from, to]
      ),
      pool.execute(
        `SELECT type_compte AS role, COUNT(*) AS n FROM users
         GROUP BY type_compte ORDER BY type_compte ASC`
      ),
      pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE created_at BETWEEN ? AND ?) AS newUsers,
           (SELECT COUNT(*) FROM users WHERE exclus = 1 AND exclude_at BETWEEN ? AND ?) AS bannedUsers,
           (SELECT COUNT(*) FROM users) AS totalUsers`,
        [from, to, from, to]
      ),
      pool.execute(
        `SELECT
           CASE
             WHEN LOWER(os_system) LIKE '%android%' THEN 'Android'
             WHEN LOWER(os_system) LIKE '%ios%' OR LOWER(os_system) LIKE '%iphone%'
                  OR LOWER(os_system) LIKE '%ipad%' THEN 'iOS'
             WHEN os_system = 'INDEFINI' OR os_system IS NULL OR os_system = '' THEN 'Inconnu'
             ELSE os_system
           END AS os,
           COUNT(*) AS n
         FROM userAccess
         WHERE dateLogin BETWEEN ? AND ?
         GROUP BY os ORDER BY n DESC LIMIT 10`,
        [from, to]
      ),
      pool.execute(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(isGroup = 1), 0) AS groupCount,
           COALESCE(SUM(isGroup = 0), 0) AS oneToOne,
           COALESCE((SELECT ROUND(AVG(cnt), 1) FROM (
             SELECT COUNT(*) AS cnt FROM conv_participants cp
             JOIN conversation c2 ON c2.conversID = cp.conversID
             WHERE c2.isGroup = 1 GROUP BY cp.conversID
           ) g), 0) AS avgGroupSize
         FROM conversation`
      ),
      pool.execute(
        `SELECT (DAYOFWEEK(sendAt) - 1) AS dow, HOUR(sendAt) AS hour, COUNT(*) AS count
         FROM message WHERE sendAt BETWEEN ? AND ?
         GROUP BY dow, hour`,
        [from, to]
      ),
      pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM message     WHERE sendAt     BETWEEN ? AND ?) AS messages,
           (SELECT COUNT(*) FROM callHistory WHERE created_at BETWEEN ? AND ?) AS calls,
           (SELECT COUNT(*) FROM statut      WHERE createdAt  BETWEEN ? AND ?) AS statuses,
           (SELECT COUNT(*) FROM users       WHERE created_at BETWEEN ? AND ?) AS registrations`,
        [prevFrom, prevTo, prevFrom, prevTo, prevFrom, prevTo, prevFrom, prevTo]
      ),
    ]);

    const callsTotal = _num(callAgg.total);
    const callsAnswered = _num(callAgg.answered);
    const storyTotal = _num(storyAgg.total);
    const storyViews = _num(storyAgg.totalViews);
    const storyLikes = _num(storyAgg.totalLikes);
    const mAccepted = _num(meetingAgg.accepted);
    const mDeclined = _num(meetingAgg.declined);
    const mInvited  = _num(meetingAgg.invited);
    const mResponses = mAccepted + mDeclined + mInvited;

    res.json({
      messagesByType: msgByType.map((r) => ({
        type: r.type,
        label: _MESSAGE_TYPE_LABELS[r.type] ?? `Type ${r.type}`,
        count: _num(r.n),
      })),
      messagesByDay: msgByDay.map((r) => ({ date: r.date, count: _num(r.count) })),
      calls: {
        total: callsTotal,
        audio: _num(callAgg.audio),
        video: _num(callAgg.video),
        answered: callsAnswered,
        missed: _num(callAgg.missed),
        rejected: _num(callAgg.rejected),
        avgDuration: _num(callAgg.avgDuration),
        totalDuration: _num(callAgg.totalDuration),
        successRate: callsTotal ? Math.round((callsAnswered / callsTotal) * 100) : 0,
      },
      callsByDay: callsByDay.map((r) => ({
        date: r.date, audio: _num(r.audio), video: _num(r.video),
      })),
      stories: {
        total: storyTotal,
        totalViews: storyViews,
        totalLikes: storyLikes,
        avgViews: storyTotal ? Math.round(storyViews / storyTotal) : 0,
        engagementRate: storyViews ? Math.round((storyLikes / storyViews) * 100) : 0,
        byType: storyByType.map((r) => ({
          type: r.type,
          label: _STATUS_TYPE_LABELS[r.type] ?? `Type ${r.type}`,
          count: _num(r.n),
        })),
      },
      meetings: {
        total: _num(meetingAgg.total),
        avgDuration: _num(meetingAgg.avgDuration),
        accepted: mAccepted,
        declined: mDeclined,
        invited: mInvited,
        attendanceRate: mResponses ? Math.round((mAccepted / mResponses) * 100) : 0,
        noShowRate: mResponses ? Math.round(((mDeclined + mInvited) / mResponses) * 100) : 0,
      },
      users: {
        byRole: usersByRole.map((r) => ({
          role: r.role,
          label: _ROLE_LABELS[r.role] ?? `Rôle ${r.role}`,
          count: _num(r.n),
        })),
        newUsers: _num(userGrowth.newUsers),
        bannedUsers: _num(userGrowth.bannedUsers),
        totalUsers: _num(userGrowth.totalUsers),
      },
      devices: devices.map((r) => ({ os: r.os, count: _num(r.n) })),
      conversations: {
        total: _num(convAgg.total),
        groups: _num(convAgg.groupCount),
        oneToOne: _num(convAgg.oneToOne),
        avgGroupSize: _num(convAgg.avgGroupSize),
      },
      heatmap: heatmap.map((r) => ({
        dow: _num(r.dow), hour: _num(r.hour), count: _num(r.count),
      })),
      comparison: {
        messages: _num(comparison.messages),
        calls: _num(comparison.calls),
        statuses: _num(comparison.statuses),
        registrations: _num(comparison.registrations),
      },
      period: { from, to },
      previousPeriod: { from: prevFrom, to: prevTo },
    });
  } catch (error) {
    console.error('[Admin] getAnalytics error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAnalytics };
