const pool = require('../../config/db');
const { _notifyUserAccountAction } = require('./helpers');

// Utilisateurs (liste complète, détails, bannissement, rôle, suppression…)
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

// Détails d'un utilisateur par ID (alanyaID)
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

// Activité d'un utilisateur : messages, appels, stories, conversations
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

// Dernières connexions des utilisateurs (userAccess) : device, dateLogin, ipAdress, os_system
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

// Bannir un utilisateur (exclus = 1) : soft-delete, il ne peut plus se connecter. Super-admin uniquement.
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

// Débannir un utilisateur (exclus = 0) : il peut se reconnecter. Super-admin uniquement.
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

// Promouvoir ou rétrograder un utilisateur (type_compte = 0, 1 ou 2). Super-admin uniquement.
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

// Supprimer un utilisateur (DELETE) : supprime définitivement le compte + données associées. Super-admin uniquement.
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
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  deleteUser,
};
