const pool = require('../config/db');
const { getBlockPair } = require('../utils/blockUtils');
const { canViewProfileField } = require('../services/privacyPrefsService');
const { normalize, isNumericQuery } = require('../utils/alanyaPhone');

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

const _maskProfileFields = async (viewerId, targetId, row) => {
  const base = { ...row };
  if (viewerId == null || Number(viewerId) === Number(targetId)) {
    return { ...base, avatar_url: sanitizeUrl(base.avatar_url) };
  }

  const [showAvatar, showOnline, showLastSeen] = await Promise.all([
    canViewProfileField(viewerId, targetId, 'avatar_url'),
    canViewProfileField(viewerId, targetId, 'is_online'),
    canViewProfileField(viewerId, targetId, 'last_seen'),
  ]);

  return {
    ...base,
    avatar_url: showAvatar ? sanitizeUrl(base.avatar_url) : null,
    is_online: showOnline ? base.is_online : 0,
    last_seen: showLastSeen ? base.last_seen : null,
  };
};

const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const viewerId = req.user.alanyaID;
    const targetId = parseInt(id, 10);
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.idPays,
              u.avatar_url, u.type_compte, u.is_online, u.last_seen,
              p.libelle AS pays_libelle, p.prefix AS pays_prefix
         FROM users u
         LEFT JOIN pays p ON u.idPays = p.idPays
        WHERE u.alanyaID = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const pair = await getBlockPair(viewerId, targetId);
    const masked = await _maskProfileFields(viewerId, targetId, rows[0]);
    if (pair.theyBlockedMe) {
      return res.json({
        ...masked,
        avatar_url: null,
        is_online: 0,
        last_seen: null,
      });
    }
    res.json(masked);
  } catch (error) {
    throw error;
  }
};

const getUserByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const canonical = normalize(phone);
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.idPays,
              u.avatar_url, u.is_online,
              p.libelle AS pays_libelle, p.prefix AS pays_prefix
         FROM users u
         LEFT JOIN pays p ON u.idPays = p.idPays
        WHERE u.alanyaPhone = ? AND u.exclus = 0`,
      [canonical]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows.map(u => ({ ...u, avatar_url: sanitizeUrl(u.avatar_url) })));
  } catch (error) {
    throw error;
  }
};

const searchUsers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const trimmed = String(q).trim();
    let rows;

    // Le pays voyage avec l'utilisateur : sans lui, la fiche contact ne peut
    // l'afficher qu'après un aller-retour supplémentaire sur /users/:id.
    if (isNumericQuery(trimmed)) {
      const canonical = normalize(trimmed);
      [rows] = await pool.execute(
        `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.idPays,
                u.avatar_url, u.is_online,
                p.libelle AS pays_libelle, p.prefix AS pays_prefix
           FROM users u
           LEFT JOIN pays p ON u.idPays = p.idPays
          WHERE u.alanyaPhone = ? AND u.exclus = 0
          LIMIT 20`,
        [canonical]
      );
    } else {
      [rows] = await pool.execute(
        `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.idPays,
                u.avatar_url, u.is_online,
                p.libelle AS pays_libelle, p.prefix AS pays_prefix
           FROM users u
           LEFT JOIN pays p ON u.idPays = p.idPays
          WHERE (u.nom = ? OR u.pseudo = ?) AND u.exclus = 0
          LIMIT 20`,
        [trimmed, trimmed]
      );
    }

    res.json(rows.map((u) => ({ ...u, avatar_url: sanitizeUrl(u.avatar_url) })));
  } catch (error) {
    throw error;
  }
};

const blockUser = async (req, res) => {
  try {
    const { id } = req.params;         // cible (l'utilisateur à bloquer)
    const alanyaID = req.user.alanyaID; // moi (owner du blocage)

    // blocked.alanyaID = owner (moi), blocked.idCallerBlock = target (l'autre)
    const [existing] = await pool.execute(
      'SELECT * FROM blocked WHERE alanyaID = ? AND idCallerBlock = ?',
      [alanyaID, id]
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: 'User already blocked' });
    }

    await pool.execute(
      'INSERT INTO blocked (alanyaID, idCallerBlock, dateBlock) VALUES (?, ?, NOW())',
      [alanyaID, id]
    );

    res.json({ message: 'User blocked' });
  } catch (error) {
    throw error;
  }
};

const unblockUser = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    await pool.execute(
      'DELETE FROM blocked WHERE alanyaID = ? AND idCallerBlock = ?',
      [alanyaID, id]
    );

    res.json({ message: 'User unblocked' });
  } catch (error) {
    throw error;
  }
};

// Statut de blocage bidirectionnel entre moi et :id
const getBlockStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const pair = await getBlockPair(alanyaID, parseInt(id, 10));
    res.json({ isBlocked: pair.iBlockedThem, blockedByThem: pair.theyBlockedMe });
  } catch (error) {
    throw error;
  }
};

/** Liste des utilisateurs que j'ai bloqués. */
const getBlockedUsers = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT
         u.alanyaID,
         u.nom,
         u.pseudo,
         u.alanyaPhone,
         u.idPays,
         u.avatar_url,
         u.is_online,
         u.last_seen,
         p.libelle AS pays_libelle,
         p.prefix AS pays_prefix,
         b.dateBlock
       FROM blocked b
       JOIN users u ON b.idCallerBlock = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE b.alanyaID = ?
       ORDER BY b.dateBlock DESC, u.nom ASC`,
      [alanyaID]
    );

    res.json(
      rows.map((r) => ({
        alanyaID: r.alanyaID,
        nom: r.nom,
        pseudo: r.pseudo,
        alanyaPhone: r.alanyaPhone,
        idPays: r.idPays,
        pays_libelle: r.pays_libelle,
        pays_prefix: r.pays_prefix,
        avatar_url: sanitizeUrl(r.avatar_url),
        is_online: 0,
        last_seen: null,
        dateBlock: r.dateBlock,
      }))
    );
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getUserById,
  getUserByPhone,
  searchUsers,
  blockUser,
  unblockUser,
  getBlockStatus,
  getBlockedUsers,
};