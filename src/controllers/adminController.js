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

module.exports = {
  adminLogin,
  getStats,
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  deleteUser,
};
