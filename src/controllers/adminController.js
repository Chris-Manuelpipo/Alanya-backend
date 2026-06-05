const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { sendMail, renderHtmlEmail, escapeHtml } = require('../services/mailService');
const {
  generateAccessToken,
  generateRefreshToken,
} = require('../middleware/authCustom');

// Helper pour `from` par défaut
const _daysAgoIso = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

// Libellés métier (cf. commentaires SQL des colonnes `type`)
const _MESSAGE_TYPE_LABELS = ['Texte', 'Image', 'Vidéo', 'Audio', 'Fichier', 'Localisation'];
const _STATUS_TYPE_LABELS  = ['Texte', 'Image', 'Vidéo'];
const _ROLE_LABELS = { 0: 'Utilisateur', 1: 'Admin', 2: 'Super-admin' };

// Conversion sûre des agrégats SQL (SUM peut renvoyer NULL ou une string)
const _num = (v) => Number(v) || 0;

// Formatage relatif FR pour le feed d'activité
const _relativeTime = (date) => {
  const ts = new Date(date).getTime();
  if (Number.isNaN(ts)) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)     return "à l'instant";
  if (diff < 3600)   return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400)  return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `il y a ${Math.floor(diff / 86400)} j`;
  return new Date(date).toLocaleDateString('fr-FR');
};

const _appName = process.env.APP_NAME || 'Alanya';

const _buildUserMailFrom = () => {
  const fromEmail = process.env.SMTP_FROM;
  const fromName = process.env.MAIL_FROM_NAME || _appName;
  return fromEmail ? `"${fromName}" <${fromEmail}>` : undefined;
};

const _notifyUserAccountAction = async ({ email, nom, action, reason }) => {
  if (!email) return;

  const subject =
    action === 'ban'
      ? `Votre compte a été banni sur ${_appName}`
      : `Votre compte a été supprimé sur ${_appName}`;
  const title = action === 'ban' ? 'Compte suspendu' : 'Compte supprimé';
  const lead = action === 'ban'
    ? `Votre compte sur ${_appName} a été suspendu par un administrateur.`
    : `Votre compte sur ${_appName} a été supprimé par un administrateur.`;
  const safeReason = reason ? escapeHtml(reason) : '';
  const bodyHtml = `
    <p>Bonjour ${escapeHtml(nom || 'utilisateur')},</p>
    <p>${escapeHtml(lead)}</p>
    ${reason ? `<div style="margin-top:18px;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:6px">Motif</div><div style="color:#111827">${safeReason}</div></div>` : ''}
    <p style="margin-top:18px;">Si vous pensez qu'il s'agit d'une erreur, contactez le support.</p>`;
  const text = `${lead}${reason ? `\n\nMotif : ${reason}` : ''}\n\nSi vous pensez qu'il s'agit d'une erreur, contactez le support.`;
  const html = renderHtmlEmail({
    title,
    preheader: title,
    eyebrow: _appName,
    heading: title,
    intro: 'Notification de sécurité et de compte',
    bodyHtml,
    accent: action === 'ban' ? '#e11d48' : '#111827',
    footerNote: 'Cet email est envoyé automatiquement, merci de ne pas y répondre.',
  });

  await sendMail({
    from: _buildUserMailFrom(),
    to: email,
    subject,
    text,
    html,
  });
};

// ── POST /api/admin/auth/login ─────────────────────────────────────
// Login dédié web : email + password, refuse type_compte = 0
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const [rows] = await pool.execute(
      `SELECT alanyaID, nom, pseudo, alanyaPhone, email, password,
              avatar_url, type_compte, exclus
       FROM users WHERE email = ?`,
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const u = rows[0];
    if (u.exclus === 1) {
      return res.status(403).json({ error: 'Compte banni' });
    }
    if ((u.type_compte ?? 0) < 1) {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const ok = await bcrypt.compare(password, u.password);
    if (!ok) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const payload = { alanyaID: u.alanyaID, email: u.email };
    res.json({
      accessToken: generateAccessToken(payload),
      refreshToken: generateRefreshToken(payload),
      user: {
        alanyaID: u.alanyaID,
        nom: u.nom,
        pseudo: u.pseudo,
        email: u.email,
        alanyaPhone: u.alanyaPhone,
        avatar_url: u.avatar_url,
        type_compte: u.type_compte,
      },
    });
  } catch (error) {
    console.error('[Admin] login error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── GET /api/admin/stats?from=&to= ─────────────────────────────────
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

// ── GET /api/admin/users?search=&status=&from=&to=&idPays=&sort=&page=&limit= ──
const getUsers = async (req, res) => {
  try {
    const {
      search = '',
      status = '',
      from = '',
      to = '',
      idPays = '',
      sort = 'created_at',
      order = 'desc',
      page = 1,
      limit = 20,
    } = req.query;

    const where = [];
    const params = [];

    if (search) {
      where.push('(u.nom LIKE ? OR u.pseudo LIKE ? OR u.alanyaPhone LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (status === 'online')  { where.push('u.is_online = ?'); params.push(1); }
    if (status === 'banned')  { where.push('u.exclus = ?'); params.push(1); }
    if (status === 'admin')   { where.push('u.type_compte >= ?'); params.push(1); }
    if (from) { where.push('u.created_at >= ?'); params.push(from); }
    if (to)   { where.push('u.created_at <= ?'); params.push(to); }
    if (idPays) { where.push('u.idPays = ?'); params.push(idPays); }

    const allowedSort = { created_at: 'u.created_at', nom: 'u.nom', last_seen: 'u.last_seen' };
    const sortCol = allowedSort[sort] || 'u.created_at';
    const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const pageN  = Math.max(1, parseInt(page, 10));
    const limitN = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageN - 1) * limitN;

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // NB: LIMIT/OFFSET interpolés (mysql2 ne supporte pas le bind sur ces
    // tokens via prepared statements). Valeurs validées en entiers ci-dessus.
    const [items] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
              u.type_compte, u.is_online, u.last_seen, u.exclus, u.exclude_at,
              u.exclude_reason, u.created_at, u.idPays, p.libelle AS pays_libelle
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       ${whereSql}
       ORDER BY ${sortCol} ${dir}
       LIMIT ${limitN} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM users u ${whereSql}`,
      params
    );

    res.json({ items, total, page: pageN, limit: limitN });
  } catch (error) {
    console.error('[Admin] getUsers error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── GET /api/admin/users/:id ───────────────────────────────────────
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
              u.type_compte, u.is_online, u.last_seen, u.exclus, u.exclude_at,
              u.exclude_reason, u.created_at, u.idPays, u.fcm_token, u.device_ID,
              p.libelle AS pays_libelle, p.prefix AS pays_prefix
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE u.alanyaID = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json(rows[0]);
  } catch (error) {
    console.error('[Admin] getUserById error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── GET /api/admin/users/:id/activity ──────────────────────────────
const getUserActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const [
      [[m]],
      [[c]],
      [[ci]],
      [[s]],
      [[conv]],
    ] = await Promise.all([
      pool.execute('SELECT COUNT(*) AS n FROM message     WHERE senderID = ?', [id]),
      pool.execute('SELECT COUNT(*) AS n FROM callHistory WHERE idCaller = ?', [id]),
      pool.execute('SELECT COUNT(*) AS n FROM callHistory WHERE idReceiver = ?', [id]),
      pool.execute('SELECT COUNT(*) AS n FROM statut      WHERE alanyaID = ?', [id]),
      pool.execute('SELECT COUNT(DISTINCT conversID) AS n FROM conv_participants WHERE alanyaID = ?', [id]),
    ]);
    res.json({
      messagesSent: m.n,
      callsMade: c.n,
      callsReceived: ci.n,
      statusesPublished: s.n,
      conversations: conv.n,
    });
  } catch (error) {
    console.error('[Admin] getUserActivity error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── GET /api/admin/users/:id/logins?limit=50 ───────────────────────
const getUserLogins = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const [rows] = await pool.execute(
      `SELECT idLogin, alanyaID, device, dateLogin, ipAdress, os_system
       FROM userAccess
       WHERE alanyaID = ?
       ORDER BY dateLogin DESC
       LIMIT ${limit}`,
      [id]
    );
    res.json(rows);
  } catch (error) {
    console.error('[Admin] getUserLogins error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── POST /api/admin/users/:id/ban ──────────────────────────────────
const banUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (Number(id) === req.user.alanyaID) {
      return res.status(400).json({ error: 'Impossible de se bannir soi-même' });
    }
    const [users] = await pool.execute(
      'SELECT email, nom, type_compte FROM users WHERE alanyaID = ?',
      [id]
    );
    if (users.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if ((users[0].type_compte ?? 0) >= 2) {
      return res.status(403).json({ error: 'Impossible de bannir un super-admin' });
    }
    const [result] = await pool.execute(
      `UPDATE users
       SET exclus = 1, exclude_at = NOW(), exclude_reason = ?
       WHERE alanyaID = ?`,
      [reason || null, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    _notifyUserAccountAction({
      email: users[0]?.email,
      nom: users[0]?.nom,
      action: 'ban',
      reason,
    }).catch((error) => {
      console.error('[Admin] banUser mail error:', error.message);
    });
    res.json({ message: 'Utilisateur banni' });
  } catch (error) {
    console.error('[Admin] banUser error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── DELETE /api/admin/users/:id/ban ────────────────────────────────
const unbanUser = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute(
      `UPDATE users
       SET exclus = 0, exclude_at = NULL, exclude_reason = NULL
       WHERE alanyaID = ?`,
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ message: 'Utilisateur débanni' });
  } catch (error) {
    console.error('[Admin] unbanUser error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── PUT /api/admin/users/:id/role { type_compte } ─────────────────
// Super-admin uniquement
const setAccountType = async (req, res) => {
  try {
    const { id } = req.params;
    const { type_compte } = req.body || {};
    const t = Number(type_compte);
    if (![0, 1, 2].includes(t)) {
      return res.status(400).json({ error: 'type_compte doit être 0, 1 ou 2' });
    }
    if (Number(id) === req.user.alanyaID && t < 2) {
      return res.status(400).json({ error: 'Impossible de se rétrograder soi-même' });
    }
    const [users] = await pool.execute(
      'SELECT type_compte FROM users WHERE alanyaID = ?',
      [id]
    );
    if (users.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if ((users[0].type_compte ?? 0) >= 2 && t < 2) {
      return res.status(403).json({ error: 'Impossible de rétrograder un super-admin' });
    }
    const [result] = await pool.execute(
      'UPDATE users SET type_compte = ? WHERE alanyaID = ?',
      [t, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ message: 'Rôle mis à jour', type_compte: t });
  } catch (error) {
    console.error('[Admin] setAccountType error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── DELETE /api/admin/users/:id ────────────────────────────────────
// Super-admin uniquement
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (Number(id) === req.user.alanyaID) {
      return res.status(400).json({ error: 'Impossible de se supprimer soi-même' });
    }
    const [users] = await pool.execute(
      'SELECT email, nom FROM users WHERE alanyaID = ?',
      [id]
    );
    const [result] = await pool.execute('DELETE FROM users WHERE alanyaID = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    _notifyUserAccountAction({
      email: users[0]?.email,
      nom: users[0]?.nom,
      action: 'delete',
    }).catch((error) => {
      console.error('[Admin] deleteUser mail error:', error.message);
    });
    res.json({ message: 'Utilisateur supprimé' });
  } catch (error) {
    console.error('[Admin] deleteUser error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

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

// ── GET /api/admin/activity?limit=20 ───────────────────────────────
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

// ── GET /api/admin/media?type=&search=&page=&limit= ────────────────
// Médias partagés (messages de type image/vidéo/audio/fichier) avec
// expéditeur + nom de conversation. Renvoie un tableau MediaItem[].
const getAllMedia = async (req, res) => {
  try {
    const { type = '', search = '' } = req.query;

    const where = [
      'm.type IN (1, 2, 3, 4)',
      "m.mediaUrl IS NOT NULL",
      "m.mediaUrl <> ''",
      'm.isDeleted = 0',
    ];
    const params = [];

    const typeN = parseInt(type, 10);
    if ([1, 2, 3, 4].includes(typeN)) { where.push('m.type = ?'); params.push(typeN); }
    if (search) { where.push('m.mediaName LIKE ?'); params.push(`%${search}%`); }

    const pageN  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitN = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const offset = (pageN - 1) * limitN;

    const [items] = await pool.execute(
      `SELECT m.msgID AS id,
              m.senderID,
              u.nom        AS sender_nom,
              u.pseudo     AS sender_pseudo,
              u.avatar_url AS sender_avatar,
              m.conversationID,
              COALESCE(
                CASE WHEN c.isGroup = 1 THEN c.GroupName
                     ELSE (SELECT u2.nom FROM conv_participants cp
                           JOIN users u2 ON u2.alanyaID = cp.alanyaID
                           WHERE cp.conversID = c.conversID AND cp.alanyaID <> m.senderID
                           ORDER BY cp.id LIMIT 1)
                END, 'Conversation') AS conversation_name,
              m.type,
              m.mediaUrl,
              COALESCE(m.mediaName, 'fichier') AS mediaName,
              m.sendAt
       FROM message m
       JOIN users u        ON u.alanyaID  = m.senderID
       JOIN conversation c ON c.conversID = m.conversationID
       WHERE ${where.join(' AND ')}
       ORDER BY m.sendAt DESC
       LIMIT ${limitN} OFFSET ${offset}`,
      params
    );

    res.json(items);
  } catch (error) {
    console.error('[Admin] getAllMedia error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── GET /api/admin/groups?search=&limit= ───────────────────────────
// Tous les groupes de l'application (pas seulement ceux de l'admin),
// avec nombre de membres et date de création approchée (1er joinedAt).
const getAllGroups = async (req, res) => {
  try {
    const { search = '' } = req.query;
    const where = ['c.isGroup = 1'];
    const params = [];
    if (search) { where.push('c.GroupName LIKE ?'); params.push(`%${search}%`); }

    const limitN = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

    const [items] = await pool.execute(
      `SELECT c.conversID,
              c.GroupName,
              c.groupPhoto,
              c.lastMessage,
              c.lastMessageAt,
              (SELECT COUNT(*) FROM conv_participants cp WHERE cp.conversID = c.conversID) AS members,
              (SELECT MIN(cp2.joinedAt) FROM conv_participants cp2 WHERE cp2.conversID = c.conversID) AS createdAt
       FROM conversation c
       WHERE ${where.join(' AND ')}
       ORDER BY c.lastMessageAt IS NULL, c.lastMessageAt DESC, c.conversID DESC
       LIMIT ${limitN}`,
      params
    );

    res.json(items);
  } catch (error) {
    console.error('[Admin] getAllGroups error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── GET /api/admin/groups/:id ──────────────────────────────────────
// Détails d'un groupe + liste complète des membres.
const getGroupById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT conversID, isGroup, GroupName, groupPhoto, lastMessage, lastMessageAt
       FROM conversation WHERE conversID = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Groupe introuvable' });
    const g = rows[0];

    const [members] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url, u.alanyaPhone,
              u.is_online, u.last_seen, u.type_compte, cp.joinedAt
       FROM conv_participants cp
       JOIN users u ON u.alanyaID = cp.alanyaID
       WHERE cp.conversID = ?
       ORDER BY cp.joinedAt ASC`,
      [id]
    );
    const [[{ messageCount }]] = await pool.execute(
      'SELECT COUNT(*) AS messageCount FROM message WHERE conversationID = ?',
      [id]
    );

    res.json({
      conversID: g.conversID,
      isGroup: g.isGroup,
      GroupName: g.GroupName,
      groupPhoto: g.groupPhoto,
      lastMessage: g.lastMessage,
      lastMessageAt: g.lastMessageAt,
      memberCount: members.length,
      messageCount,
      createdAt: members.length ? members[0].joinedAt : null,
      members: members.map((m) => ({
        alanyaID: m.alanyaID,
        nom: m.nom,
        pseudo: m.pseudo,
        avatar_url: (m.avatar_url && String(m.avatar_url).startsWith('http')) ? m.avatar_url : null,
        alanyaPhone: m.alanyaPhone,
        is_online: m.is_online,
        last_seen: m.last_seen,
        type_compte: m.type_compte,
        joinedAt: m.joinedAt,
      })),
    });
  } catch (error) {
    console.error('[Admin] getGroupById error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── DELETE /api/admin/groups/:id ───────────────────────────────────
// Supprime un groupe + ses messages + ses participants.
const deleteGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT conversID FROM conversation WHERE conversID = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Groupe introuvable' });
    await pool.execute('DELETE FROM message WHERE conversationID = ?', [id]);
    await pool.execute('DELETE FROM conv_participants WHERE conversID = ?', [id]);
    await pool.execute('DELETE FROM conversation WHERE conversID = ?', [id]);
    res.json({ message: 'Groupe supprimé' });
  } catch (error) {
    console.error('[Admin] deleteGroup error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  adminLogin,
  getStats,
  getAnalytics,
  getActivityFeed,
  getAllMedia,
  getAllGroups,
  getGroupById,
  deleteGroup,
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  deleteUser,
};
