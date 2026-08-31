const pool = require('../../config/db');
const {
  _daysAgoIso,
  _num,
  _MESSAGE_TYPE_LABELS,
  _STATUS_TYPE_LABELS,
  _ROLE_LABELS,
} = require('./helpers');

/** Agrégations analytics — partagées entre GET /analytics et export PDF. */
async function fetchAnalyticsData(fromInput, toInput) {
  const from = fromInput || _daysAgoIso(7);
  const to = toInput || new Date().toISOString();

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const spanMs = Math.max(0, toMs - fromMs);
  const prevFrom = new Date(fromMs - spanMs).toISOString();
  const prevTo = from;

  const [
    [msgByType],
    [msgByDay],
    [[callAgg]],
    [callsByDay],
    [[storyAgg]],
    [storyByType],
    [[meetingAgg]],
    [[meetingParts]],
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
      [from, to],
    ),
    pool.execute(
      `SELECT DATE(sendAt) AS date, COUNT(*) AS count FROM message
       WHERE sendAt BETWEEN ? AND ? GROUP BY DATE(sendAt) ORDER BY date ASC`,
      [from, to],
    ),
    // `missed` compte 0 ET 3 : deux statuts pour un même fait, séquelle de deux
    // conventions qui ont cohabité. Le schéma dit 0 = manqué, le handler socket
    // écrit 3 sur timeout sans réponse. Ne compter que 0 laissait les lignes en
    // 3 hors de TOUTE catégorie — ni répondues, ni manquées, ni rejetées. Les
    // trois restent disjointes, leur somme reste le total : le camembert de
    // l'écran Analytics en dépend.
    //
    // `totalDuration` filtre sur le décrochage : sans ce filtre, il comptait le
    // temps de SONNERIE des appels sans réponse comme du temps d'appel —
    // 3 143 heures au 31/08/2026. La moyenne juste en dessous filtrait déjà.
    pool.execute(
      `SELECT
         COUNT(*)             AS total,
         SUM(type = 0)        AS audio,
         SUM(type = 1)        AS video,
         SUM(status = 1)      AS answered,
         SUM(status = 0 OR status = 3) AS missed,
         SUM(status = 2)      AS rejected,
         SUM(mode = 0)        AS relay,
         SUM(mode = 1)        AS p2p,
         SUM(mode IS NULL)    AS modeUnknown,
         COALESCE(ROUND(AVG(CASE WHEN status = 1 THEN duree END)), 0) AS avgDuration,
         COALESCE(SUM(CASE WHEN status = 1 THEN duree ELSE 0 END), 0) AS totalDuration
       FROM callHistory WHERE created_at BETWEEN ? AND ?`,
      [from, to],
    ),
    pool.execute(
      `SELECT DATE(created_at) AS date,
              SUM(type = 0) AS audio,
              SUM(type = 1) AS video
       FROM callHistory WHERE created_at BETWEEN ? AND ?
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [from, to],
    ),
    pool.execute(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(viewedBy), 0) AS totalViews,
              COALESCE(SUM(likedBy), 0)  AS totalLikes
       FROM statut WHERE createdAt BETWEEN ? AND ?`,
      [from, to],
    ),
    pool.execute(
      `SELECT type, COUNT(*) AS n FROM statut
       WHERE createdAt BETWEEN ? AND ? GROUP BY type ORDER BY type ASC`,
      [from, to],
    ),
    // Réunions, niveau réunion. Surtout PAS de jointure avec `participant`
    // ici : un AVG calculé après la jointure est pondéré par le nombre de
    // participants — une réunion à quatre pèse quatre fois.
    //
    // Deux durées, parce que `meeting.duree` n'est pas celle qu'on croit :
    // c'est la durée PLANIFIÉE, en MINUTES (cf. `Meeting.duree` côté app,
    // `endDateTime = start + Duration(minutes: duree)`), écrite à la création
    // et jamais corrigée à la fin — le handler de clôture ne pose que
    // `isEnd = 1`. La durée réellement vécue se reconstitue depuis
    // `participant.duree`, en SECONDES, écrite au départ de chaque
    // participant : la réunion a duré aussi longtemps que son dernier présent.
    pool.execute(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(m.isEnd = 1), 0) AS ended,
         COALESCE(ROUND(AVG(m.duree)), 0) AS avgPlannedMinutes,
         COALESCE((SELECT ROUND(AVG(x.reel)) FROM (
           SELECT MAX(p.duree) AS reel
             FROM participant p
             JOIN meeting m2 ON m2.idMeeting = p.idMeeting
            WHERE m2.start_time BETWEEN ? AND ?
            GROUP BY p.idMeeting
           HAVING MAX(p.duree) > 0
         ) x), 0) AS avgRealDuration
       FROM meeting m
       WHERE m.start_time BETWEEN ? AND ?`,
      [from, to, from, to],
    ),
    // Réunions, niveau participant. Deux familles de mesures qui ne se
    // recouvrent pas :
    //
    //  — la réponse à l'invitation (`status`), hors organisateur : celui-ci est
    //    auto-inséré `status = 1` à la création de la réunion, le compter
    //    ferait remonter un « accepté » garanti par réunion ;
    //  — la présence réelle (`duree > 0`), organisateur compris : lui aussi
    //    assiste, et sa durée est écrite comme celle des autres.
    //
    // Un no-show, c'est avoir accepté puis n'être jamais venu — pas « ne pas
    // avoir répondu », que l'ancien calcul confondait avec un refus.
    pool.execute(
      `SELECT
         COUNT(*) AS participants,
         COALESCE(SUM(p.duree > 0), 0) AS attendees,
         COALESCE(SUM(p.IDparticipant <> m.idOrganiser), 0) AS invitations,
         COALESCE(SUM(p.status = 1 AND p.IDparticipant <> m.idOrganiser), 0) AS accepted,
         COALESCE(SUM(p.status = 2 AND p.IDparticipant <> m.idOrganiser), 0) AS declined,
         COALESCE(SUM(p.status = 0 AND p.IDparticipant <> m.idOrganiser), 0) AS pending,
         COALESCE(SUM(p.status = 1 AND p.duree = 0
                      AND p.IDparticipant <> m.idOrganiser), 0) AS noShow
       FROM participant p
       JOIN meeting m ON m.idMeeting = p.idMeeting
       WHERE m.start_time BETWEEN ? AND ?`,
      [from, to],
    ),
    pool.execute(
      `SELECT type_compte AS role, COUNT(*) AS n FROM users
       GROUP BY type_compte ORDER BY type_compte ASC`,
    ),
    pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE created_at BETWEEN ? AND ?) AS newUsers,
         (SELECT COUNT(*) FROM users WHERE exclus = 1 AND exclude_at BETWEEN ? AND ?) AS bannedUsers,
         (SELECT COUNT(*) FROM users) AS totalUsers`,
      [from, to, from, to],
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
      [from, to],
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
       FROM conversation`,
    ),
    pool.execute(
      `SELECT (DAYOFWEEK(sendAt) - 1) AS dow, HOUR(sendAt) AS hour, COUNT(*) AS count
       FROM message WHERE sendAt BETWEEN ? AND ?
       GROUP BY dow, hour`,
      [from, to],
    ),
    pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM message     WHERE sendAt     BETWEEN ? AND ?) AS messages,
         (SELECT COUNT(*) FROM callHistory WHERE created_at BETWEEN ? AND ?) AS calls,
         (SELECT COUNT(*) FROM statut      WHERE createdAt  BETWEEN ? AND ?) AS statuses,
         (SELECT COUNT(*) FROM users       WHERE created_at BETWEEN ? AND ?) AS registrations`,
      [prevFrom, prevTo, prevFrom, prevTo, prevFrom, prevTo, prevFrom, prevTo],
    ),
  ]);

  const callsTotal = _num(callAgg.total);
  const callsAnswered = _num(callAgg.answered);
  const callsRelay = _num(callAgg.relay);
  const callsP2p = _num(callAgg.p2p);
  const callsModeKnown = callsRelay + callsP2p;
  const storyTotal = _num(storyAgg.total);
  const storyViews = _num(storyAgg.totalViews);
  const storyLikes = _num(storyAgg.totalLikes);
  const mParticipants = _num(meetingParts.participants);
  const mAttendees = _num(meetingParts.attendees);
  const mInvitations = _num(meetingParts.invitations);
  const mAccepted = _num(meetingParts.accepted);
  const mDeclined = _num(meetingParts.declined);
  const mPending = _num(meetingParts.pending);
  const mNoShow = _num(meetingParts.noShow);

  return {
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
      relay: callsRelay,
      p2p: callsP2p,
      modeUnknown: _num(callAgg.modeUnknown),
      relayRate: callsModeKnown ? Math.round((callsRelay / callsModeKnown) * 100) : 0,
      p2pRate: callsModeKnown ? Math.round((callsP2p / callsModeKnown) * 100) : 0,
      successRate: callsTotal ? Math.round((callsAnswered / callsTotal) * 100) : 0,
    },
    callsByDay: callsByDay.map((r) => ({
      date: r.date,
      audio: _num(r.audio),
      video: _num(r.video),
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
      ended: _num(meetingAgg.ended),
      avgPlannedMinutes: _num(meetingAgg.avgPlannedMinutes),
      avgRealDuration: _num(meetingAgg.avgRealDuration),
      participants: mParticipants,
      attendees: mAttendees,
      invitations: mInvitations,
      accepted: mAccepted,
      declined: mDeclined,
      invited: mPending,
      noShow: mNoShow,
      attendanceRate: mParticipants ? Math.round((mAttendees / mParticipants) * 100) : 0,
      acceptanceRate: mInvitations ? Math.round((mAccepted / mInvitations) * 100) : 0,
      noShowRate: mAccepted ? Math.round((mNoShow / mAccepted) * 100) : 0,
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
      dow: _num(r.dow),
      hour: _num(r.hour),
      count: _num(r.count),
    })),
    comparison: {
      messages: _num(comparison.messages),
      calls: _num(comparison.calls),
      statuses: _num(comparison.statuses),
      registrations: _num(comparison.registrations),
    },
    period: { from, to },
    previousPeriod: { from: prevFrom, to: prevTo },
  };
}

const ALL_ANALYTICS_SECTIONS = [
  'summary',
  'messaging',
  'calls',
  'stories',
  'meetings',
  'users',
  'conversations',
  'devices',
  'heatmap',
];

function parseAnalyticsSections(sectionsParam) {
  if (!sectionsParam || String(sectionsParam).trim() === '') {
    return new Set(ALL_ANALYTICS_SECTIONS);
  }
  const requested = String(sectionsParam)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((s) => ALL_ANALYTICS_SECTIONS.includes(s));
  return valid.length ? new Set(valid) : new Set(ALL_ANALYTICS_SECTIONS);
}

module.exports = {
  fetchAnalyticsData,
  parseAnalyticsSections,
  ALL_ANALYTICS_SECTIONS,
};
