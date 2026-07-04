const pool = require('../config/db');
const { getBlockPair } = require('../utils/blockUtils');
const { normalize, isNumericQuery } = require('../utils/alanyaPhone');

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const viewerId = req.user.alanyaID;
    const targetId = parseInt(id, 10);
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.idPays,
              u.avatar_url, u.is_online, u.last_seen,
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
    const base = { ...rows[0], avatar_url: sanitizeUrl(rows[0].avatar_url) };
    if (pair.theyBlockedMe) {
      return res.json({
        ...base,
        avatar_url: null,
        is_online: 0,
        last_seen: null,
      });
    }
    res.json(base);
  } catch (error) {
    throw error;
  }
};

const getUserByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const canonical = normalize(phone);
    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online FROM users WHERE alanyaPhone = ? AND exclus = 0',
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

    if (isNumericQuery(trimmed)) {
      const canonical = normalize(trimmed);
      [rows] = await pool.execute(
        `SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online
         FROM users
         WHERE alanyaPhone = ? AND exclus = 0
         LIMIT 20`,
        [canonical]
      );
    } else {
      [rows] = await pool.execute(
        `SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online
         FROM users
         WHERE (nom = ? OR pseudo = ?) AND exclus = 0
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
         u.avatar_url,
         u.is_online,
         u.last_seen,
         b.dateBlock
       FROM blocked b
       JOIN users u ON b.idCallerBlock = u.alanyaID
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