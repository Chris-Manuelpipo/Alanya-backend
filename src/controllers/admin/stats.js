const pool = require('../../config/db');
const { _daysAgoIso, _appName, _relativeTime } = require('./helpers');


// Renvoie KPIs + séries temporelles pour le dashboard
const getStats = async (req, res) => {
  try {
    const from = req.query.from || _daysAgoIso(7);
    const to   = req.query.to   || new Date().toISOString();

    const [
      [counters],
      [registrations],
      [activity],
      [byCountry],
      [topUsers],
    ] = await Promise.all([
      pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM users)                                       AS totalUsers,
           (SELECT COUNT(*) FROM users WHERE is_online = 1)                    AS onlineUsers,
           (SELECT COUNT(*) FROM users WHERE exclus = 1)                       AS bannedUsers,
           (SELECT COUNT(*) FROM message     WHERE sendAt     BETWEEN ? AND ?) AS messagesPeriod,
           (SELECT COUNT(*) FROM callHistory WHERE created_at BETWEEN ? AND ?) AS callsPeriod,
           (SELECT COUNT(*) FROM statut      WHERE createdAt  BETWEEN ? AND ?) AS statusesPeriod`,
        [from, to, from, to, from, to]
      ),
      pool.execute(
        `SELECT DATE(created_at) AS d, COUNT(*) AS n
         FROM users
         WHERE created_at BETWEEN ? AND ?
         GROUP BY DATE(created_at)
         ORDER BY d ASC`,
        [from, to]
      ),
      pool.execute(
        `SELECT d, SUM(n) AS n FROM (
           SELECT DATE(sendAt)     AS d, COUNT(*) AS n FROM message     WHERE sendAt     BETWEEN ? AND ? GROUP BY DATE(sendAt)
           UNION ALL
           SELECT DATE(created_at) AS d, COUNT(*) AS n FROM callHistory WHERE created_at BETWEEN ? AND ? GROUP BY DATE(created_at)
           UNION ALL
           SELECT DATE(createdAt)  AS d, COUNT(*) AS n FROM statut      WHERE createdAt  BETWEEN ? AND ? GROUP BY DATE(createdAt)
         ) t
         GROUP BY d
         ORDER BY d ASC`,
        [from, to, from, to, from, to]
      ),
      pool.execute(
        `SELECT p.libelle AS country, COUNT(*) AS n
         FROM users u JOIN pays p ON u.idPays = p.idPays
         GROUP BY p.idPays, p.libelle
         ORDER BY n DESC
         LIMIT 10`
      ),
      pool.execute(
        `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url,
                COALESCE(m.n,0) + COALESCE(c.n,0) + COALESCE(s.n,0) AS total,
                COALESCE(m.n,0) AS msgs,
                COALESCE(c.n,0) AS calls,
                COALESCE(s.n,0) AS statuses
         FROM users u
         LEFT JOIN (
           SELECT senderID AS uid, COUNT(*) AS n FROM message
           WHERE sendAt BETWEEN ? AND ? GROUP BY senderID
         ) m ON m.uid = u.alanyaID
         LEFT JOIN (
           SELECT idCaller AS uid, COUNT(*) AS n FROM callHistory
           WHERE created_at BETWEEN ? AND ? GROUP BY idCaller
         ) c ON c.uid = u.alanyaID
         LEFT JOIN (
           SELECT alanyaID AS uid, COUNT(*) AS n FROM statut
           WHERE createdAt BETWEEN ? AND ? GROUP BY alanyaID
         ) s ON s.uid = u.alanyaID
         WHERE COALESCE(m.n,0) + COALESCE(c.n,0) + COALESCE(s.n,0) > 0
         ORDER BY total DESC
         LIMIT 10`,
        [from, to, from, to, from, to]
      ),
    ]);

    // Construire la réponse avec des valeurs par défaut pour les résultats vides
    res.json({
      counters: counters[0] || {},
      registrations: registrations.length > 0 ? registrations : [],
      activity: activity.length > 0 ? activity : [],
      byCountry: byCountry.length > 0 ? byCountry : [],
      topUsers: topUsers.length > 0 ? topUsers : [],
      period: { from, to },
    });
  } catch (error) {
    console.error('[Admin] getStats error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// Feed temps réel : fusion des derniers événements (inscriptions,
// messages, appels, stories, réunions), triés par date décroissante.
const getActivityFeed = async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const [
      [users],
      [messages],
      [calls],
      [statuses],
      [meetings],
    ] = await Promise.all([
      pool.execute(
        `SELECT alanyaID AS id, nom, pseudo, created_at AS ts
         FROM users ORDER BY created_at DESC LIMIT ${limit}`
      ),
      pool.execute(
        `SELECT m.msgID AS id, u.nom, u.pseudo, m.sendAt AS ts
         FROM message m JOIN users u ON u.alanyaID = m.senderID
         ORDER BY m.sendAt DESC LIMIT ${limit}`
      ),
      pool.execute(
        `SELECT c.IDcall AS id, u.nom, u.pseudo, c.type, c.created_at AS ts
         FROM callHistory c JOIN users u ON u.alanyaID = c.idCaller
         ORDER BY c.created_at DESC LIMIT ${limit}`
      ),
      pool.execute(
        `SELECT s.ID AS id, u.nom, u.pseudo, s.createdAt AS ts
         FROM statut s JOIN users u ON u.alanyaID = s.alanyaID
         ORDER BY s.createdAt DESC LIMIT ${limit}`
      ),
      pool.execute(
        `SELECT mt.idMeeting AS id, u.nom, u.pseudo, mt.objet, mt.start_time AS ts
         FROM meeting mt JOIN users u ON u.alanyaID = mt.idOrganiser
         ORDER BY mt.start_time DESC LIMIT ${limit}`
      ),
    ]);

    const _name = (r) => r.nom || r.pseudo || 'Utilisateur';
    const events = [];
    users.forEach((r)    => events.push({ id: `u-${r.id}`,  type: 'user_joined', user: _name(r), detail: `a rejoint ${_appName}`, ts: r.ts }));
    messages.forEach((r) => events.push({ id: `m-${r.id}`,  type: 'message',     user: _name(r), detail: 'a envoyé un message', ts: r.ts }));
    calls.forEach((r)    => events.push({ id: `c-${r.id}`,  type: 'call',        user: _name(r), detail: r.type === 1 ? 'a lancé un appel vidéo' : 'a lancé un appel audio', ts: r.ts }));
    statuses.forEach((r) => events.push({ id: `s-${r.id}`,  type: 'status',      user: _name(r), detail: 'a publié un statut', ts: r.ts }));
    meetings.forEach((r) => events.push({ id: `mt-${r.id}`, type: 'meeting',     user: _name(r), detail: `a créé la réunion « ${r.objet} »`, ts: r.ts }));

    events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    res.json(
      events.slice(0, limit).map((e) => ({
        id: e.id,
        type: e.type,
        user: e.user,
        detail: e.detail,
        time: _relativeTime(e.ts),
      }))
    );
  } catch (error) {
    console.error('[Admin] getActivityFeed error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getStats, getActivityFeed };
