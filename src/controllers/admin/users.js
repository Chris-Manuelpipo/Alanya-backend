const pool = require('../../config/db');
const { ensureGroupOwner } = require('../../utils/groupOwnership');
const { _notifyUserAccountAction } = require('./helpers');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { invalidateOfficialAccountCache } = require('../../utils/officialAccountGuard');
const { guardDisplayNames } = require('../../utils/displayNameGuard');
const { buildUsersWhere, fetchUsersForExport } = require('./usersQuery');

const getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { whereSql, params, sortCol, dir } = buildUsersWhere(req.query);

    const pageN = Math.max(1, parseInt(page, 10));
    const limitN = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageN - 1) * limitN;

    const [items] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
              u.type_compte, u.account_type, u.verification_status, u.verified_until,
              up.is_online AS is_online, up.last_seen AS last_seen, u.exclus, u.exclude_at,
              u.exclude_reason, u.created_at, u.idPays, p.libelle AS pays_libelle
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       ${whereSql}
       ORDER BY ${sortCol} ${dir}
       LIMIT ${limitN} OFFSET ${offset}`,
      params,
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM users u
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       ${whereSql}`,
      params,
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
              u.type_compte, u.account_type, u.verification_status, u.verified_until,
              up.is_online AS is_online, up.last_seen AS last_seen, u.exclus, u.exclude_at,
              u.exclude_reason, u.created_at, u.idPays, u.fcm_token, u.device_ID,
              p.libelle AS pays_libelle, p.prefix AS pays_prefix
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
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
      'SELECT email, nom, account_type FROM users WHERE alanyaID = ?',
      [id]
    );
    // Le compte officiel est référencé par broadcast.sender_id, sans ON DELETE :
    // dès la première diffusion, la suppression échouerait sur une violation de
    // clé étrangère illisible. On refuse en amont, avec la marche à suivre.
    if (Number(users[0]?.account_type ?? 0) === ACCOUNT_TYPE.OFFICIEL) {
      return res.status(409).json({
        error: 'Le compte officiel ne peut pas être supprimé. Révoquez d\'abord son genre de compte.',
        code: 'OFFICIAL_NOT_DELETABLE',
      });
    }
    // Groupes dont ce compte est membre, lus AVANT la suppression : le
    // ON DELETE CASCADE de fk_cp_user va effacer ses lignes conv_participants,
    // et si c'était le propriétaire, le groupe se retrouverait sans role=2 —
    // donc ingérable, plus personne ne pouvant promouvoir. fk_conv_created_by
    // met en plus createdBy à NULL.
    const [groupesDuCompte] = await pool.execute(
      `SELECT cp.conversID
         FROM conv_participants cp
         JOIN conversation c ON c.conversID = cp.conversID
        WHERE cp.alanyaID = ? AND c.isGroup = 1`,
      [id],
    );

    const [result] = await pool.execute('DELETE FROM users WHERE alanyaID = ?', [id]);

    // Après la cascade : le garant constate l'absence de propriétaire et
    // désigne le membre restant le plus ancien.
    for (const g of groupesDuCompte) {
      await ensureGroupOwner(Number(g.conversID), {
        departingID: Number(id),
        io: req.app.get('io'),
      });
    }
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

const setUserSocle = async (req, res) => {
  try {
    const { id } = req.params;
    const { account_type, verification_status, verified_until } = req.body || {};
    const [users] = await pool.execute(
      'SELECT type_compte, account_type, nom, pseudo FROM users WHERE alanyaID = ?',
      [id],
    );
    if (!users.length) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const updates = [];
    const values = [];

    if (account_type != null) {
      const at = Number(account_type);
      if (![0, 1, 2].includes(at)) {
        return res.status(400).json({ error: 'account_type invalide' });
      }
      // Un compte officiel se crée, il ne se promeut pas. Sans cette règle, un
      // compte personnel — dont le propriétaire connaît l'e-mail, le mot de
      // passe et le code de récupération — pourrait devenir la voix de
      // l'application. La révocation reste permise.
      const wasOfficial = Number(users[0].account_type ?? 0) === ACCOUNT_TYPE.OFFICIEL;
      if (at === ACCOUNT_TYPE.OFFICIEL && !wasOfficial) {
        return res.status(409).json({
          error: 'Le compte officiel se crée depuis « Créer un utilisateur », il ne se promeut pas',
          code: 'OFFICIAL_NOT_PROMOTABLE',
        });
      }
      if ((users[0].type_compte ?? 0) >= 1 && at !== Number(users[0].account_type ?? 0)) {
        return res.status(409).json({
          error: 'Impossible de modifier le genre de compte d\'un administrateur via account_type',
        });
      }
      updates.push('account_type = ?');
      values.push(at);
    }

    if (verification_status != null) {
      updates.push('verification_status = ?');
      values.push(Number(verification_status));
    }
    if (verified_until !== undefined) {
      updates.push('verified_until = ?');
      values.push(verified_until || null);
    }

    // Révocation : le compte cesse d'être la voix de l'application, il ne doit
    // donc plus en porter le logo. Sans cela, un compte redevenu ordinaire
    // continuerait de s'afficher avec l'avatar Alanya — une usurpation par
    // simple oubli.
    if (
      account_type != null
      && Number(users[0].account_type ?? 0) === ACCOUNT_TYPE.OFFICIEL
      && Number(account_type) !== ACCOUNT_TYPE.OFFICIEL
    ) {
      updates.push('avatar_url = ?');
      values.push(process.env.AVATAR_DEFAULT_MALE || 'NON DEFINI');
    }

    if (!updates.length) return res.status(400).json({ error: 'Aucune modification' });

    values.push(id);
    await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`, values);
    // Une révocation change l'identité du compte officiel : les gardes mis en
    // cache doivent la voir immédiatement.
    if (account_type != null) invalidateOfficialAccountCache();
    res.json({ message: 'Socle de compte mis à jour' });
  } catch (error) {
    console.error('[Admin] setUserSocle error:', error.message);
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
  setUserSocle,
  deleteUser,
};
