const pool = require('../config/db');
const { markConversationReadBy } = require('../utils/readReceiptUtils');
const { getBlockPair, maskPresenceIfBlocked } = require('../utils/blockUtils');
const MAX_BATCH_CONVERSATIONS = 50;

// Nettoyer les URL d'avatar pour éviter les valeurs indésirables et les problèmes de sécurité
const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

// Attacher les participants (avec user info) à une conversation
async function attachParticipants(conversationRow, viewerId = null) {
  if (!conversationRow) return conversationRow;
  const [parts] = await pool.execute(
    `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url,
            u.alanyaPhone, u.is_online, u.last_seen
     FROM conv_participants cp
     JOIN users u ON cp.alanyaID = u.alanyaID
     WHERE cp.conversID = ?`,
    [conversationRow.conversID]
  );

  const participants = [];
  for (const p of parts) {
    const masked = await maskPresenceIfBlocked(
      viewerId, p.alanyaID, p.is_online, p.last_seen,
    );
    participants.push({
      alanyaID:    p.alanyaID,
      nom:         p.nom,
      pseudo:      p.pseudo,
      avatar_url:  sanitizeUrl(p.avatar_url),
      alanyaPhone: p.alanyaPhone,
      is_online:   masked.is_online,
      last_seen:   masked.last_seen,
    });

    if (viewerId != null && !conversationRow.isGroup
        && Number(p.alanyaID) !== Number(viewerId)) {
      const pair = await getBlockPair(viewerId, p.alanyaID);
      conversationRow.blockStatus = {
        isBlocked: pair.iBlockedThem,
        blockedByThem: pair.theyBlockedMe,
      };
    }
  }
  conversationRow.participants = participants;

  return conversationRow;
}


// Attacher les participants à plusieurs conversations en parallèle
async function attachParticipantsMany(rows, viewerId = null) {
  return Promise.all(rows.map((r) => attachParticipants(r, viewerId)));
}

/** Score pour choisir la conv 1-1 canonique entre deux utilisateurs. */
function scoreDirectConversation(row) {
  const msgCount = Number(row.messageCount) || 0;
  const lastAt = row.lastMessageAt ? new Date(row.lastMessageAt).getTime() : 0;
  // Priorité aux conv qui ont de vrais messages (évite les doublons « appel seul »).
  return msgCount * 1e15 + lastAt;
}

/**
 * Une seule entrée 1-1 par paire d'utilisateurs : garde la conversation qui
 * contient le plus de messages, puis la plus récente. Corrige les doublons
 * legacy (aperçu d'appel sur conv B, historique texte sur conv A).
 */
function dedupeDirectConversations(rows, viewerId) {
  const groups = [];
  const byPeer = new Map();
  for (const row of rows) {
    if (row.isGroup) {
      groups.push(row);
      continue;
    }
    const peer = row.participants?.find(
      (p) => Number(p.alanyaID) !== Number(viewerId),
    );
    if (!peer) {
      groups.push(row);
      continue;
    }
    const a = Math.min(Number(viewerId), Number(peer.alanyaID));
    const b = Math.max(Number(viewerId), Number(peer.alanyaID));
    const key = `${a}:${b}`;
    const existing = byPeer.get(key);
    if (!existing || scoreDirectConversation(row) > scoreDirectConversation(existing)) {
      byPeer.set(key, row);
    }
  }
  const direct = [...byPeer.values()];
  return [...groups, ...direct].sort((x, y) => {
    const pinDiff = (y.isPinned ? 1 : 0) - (x.isPinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    const xAt = x.lastMessageAt ? new Date(x.lastMessageAt).getTime() : 0;
    const yAt = y.lastMessageAt ? new Date(y.lastMessageAt).getTime() : 0;
    return yAt - xAt;
  });
}

// Récupère la liste des conversations de l'utilisateur connecté, avec les infos des participants et les métadonnées de la conversation
const getConversations = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT c.*, cp.unreadCount, cp.isPinned, cp.isArchived,
              (SELECT COUNT(*) FROM message m
               WHERE m.conversationID = c.conversID AND m.isDeleted = 0) AS messageCount
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
       WHERE cp.alanyaID = ?
       ORDER BY cp.isPinned DESC, c.lastMessageAt DESC`,
      [alanyaID]
    );
    const enriched = await attachParticipantsMany(rows, alanyaID);
    res.json(dedupeDirectConversations(enriched, alanyaID));
  } catch (error) {
    throw error;
  }
};

// Récupère une conversation spécifique par son ID, avec les infos des participants et les métadonnées
const getConversationById = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT c.*, cp.unreadCount, cp.isPinned, cp.isArchived
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
       WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [id, alanyaID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const enriched = await attachParticipants(rows[0], alanyaID);
    res.json(enriched);
  } catch (error) {
    throw error;
  }
};

// Créer une nouvelle conversation privée entre l'utilisateur connecté et un autre participant, ou un groupe si plusieurs participants sont fournis
const createConversation = async (req, res) => {
  try {
    const { participantID } = req.body;
    const alanyaID = req.user.alanyaID;

    if (!participantID) {
      return res.status(400).json({ error: 'participantID required' });
    }

    const [existing] = await pool.execute(
      `SELECT c.* FROM conversation c
       JOIN conv_participants cp1 ON c.conversID = cp1.conversID
       JOIN conv_participants cp2 ON c.conversID = cp2.conversID
       WHERE cp1.alanyaID = ? AND cp2.alanyaID = ? AND c.isGroup = 0
       ORDER BY (SELECT COUNT(*) FROM message m
                 WHERE m.conversationID = c.conversID AND m.isDeleted = 0) DESC,
                c.lastMessageAt DESC, c.conversID DESC
       LIMIT 1`,
      [alanyaID, participantID]
    );

    if (existing.length > 0) {
      const enriched = await attachParticipants(existing[0], alanyaID);
      return res.json(enriched);
    }

    const [result] = await pool.execute(
      'INSERT INTO conversation (isGroup, lastMessageAt) VALUES (0, NOW())'
    );
    const conversID = result.insertId;

    await pool.execute(
      'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
      [conversID, alanyaID]
    );
    await pool.execute(
      'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
      [conversID, participantID]
    );

    const [rows] = await pool.execute(
      'SELECT c.*, cp.unreadCount, cp.isPinned, cp.isArchived FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID WHERE c.conversID = ? AND cp.alanyaID = ?',
      [conversID, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);

    // Notifier l'autre participant en temps réel. Émission vers la room
    // `user_<id>` (rejointe à l'auth) plutôt qu'un socket-id précis : robuste
    // aux reconnexions / multi-onglets où le socket-id mémorisé est périmé.
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${parseInt(participantID)}`).emit('conversation:created', enriched);
    }

    res.json(enriched);
  } catch (error) {
    throw error;
  }
};

const createGroup = async (req, res) => {
  try {
    const { participantIDs, groupName, groupPhoto } = req.body;
    const alanyaID = req.user.alanyaID;

    if (!participantIDs || !Array.isArray(participantIDs) || participantIDs.length === 0) {
      return res.status(400).json({ error: 'participantIDs required as array' });
    }

    const [result] = await pool.execute(
      'INSERT INTO conversation (isGroup, GroupName, groupPhoto, lastMessageAt) VALUES (1, ?, ?, NOW())',
      [groupName || 'Groupe', groupPhoto || null]
    );
    const conversID = result.insertId;

    await pool.execute(
      'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
      [conversID, alanyaID]
    );

    for (const pid of participantIDs) {
      await pool.execute(
        'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
        [conversID, pid]
      );
    }

    const [rows] = await pool.execute(
      'SELECT c.*, cp.unreadCount, cp.isPinned, cp.isArchived FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID WHERE c.conversID = ? AND cp.alanyaID = ?',
      [conversID, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);

    // Notifier tous les membres du groupe en temps réel (room `user_<id>`,
    // robuste aux reconnexions vs socket-id mémorisé périmé).
    const io = req.app.get('io');
    if (io) {
      for (const pid of participantIDs) {
        io.to(`user_${parseInt(pid)}`).emit('conversation:created', enriched);
      }
    }

    res.json(enriched);
  } catch (error) {
    throw error;
  }
};

const updateConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { isPinned, isArchived, GroupName, groupPhoto } = req.body;
    const alanyaID = req.user.alanyaID;

    const updates = [];
    const values = [];

    if (GroupName) { updates.push('GroupName = ?'); values.push(GroupName); }
    if (groupPhoto !== undefined) { updates.push('groupPhoto = ?'); values.push(groupPhoto); }

    if (updates.length > 0) {
      values.push(id);
      await pool.execute(`UPDATE conversation SET ${updates.join(', ')} WHERE conversID = ?`, values);
    }

    if (typeof isPinned === 'number') {
      await pool.execute('UPDATE conv_participants SET isPinned = ? WHERE conversID = ? AND alanyaID = ?', [isPinned, id, alanyaID]);
    }
    if (typeof isArchived === 'number') {
      await pool.execute('UPDATE conv_participants SET isArchived = ? WHERE conversID = ? AND alanyaID = ?', [isArchived, id, alanyaID]);
    }

    const [rows] = await pool.execute(
      'SELECT c.*, cp.unreadCount, cp.isPinned, cp.isArchived FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID WHERE c.conversID = ? AND cp.alanyaID = ?',
      [id, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);
    res.json(enriched);
  } catch (error) {
    throw error;
  }
};

const deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    await pool.execute('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [id, alanyaID]);

    const [remaining] = await pool.execute('SELECT * FROM conv_participants WHERE conversID = ?', [id]);

    if (remaining.length === 0) {
      await pool.execute('DELETE FROM message WHERE conversationID = ?', [id]);
      await pool.execute('DELETE FROM conversation WHERE conversID = ?', [id]);
    }

    res.json({ message: 'Conversation deleted' });
  } catch (error) {
    throw error;
  }
};

const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    await markConversationReadBy({
      conversationID: id,
      readerID: alanyaID,
      io: req.app.get('io'),
    });

    res.json({ message: 'Marked as read' });
  } catch (error) {
    throw error;
  }
};

// POST /conversations/:id/participants — ajoute des participants à un groupe.
// L'appelant doit déjà être membre. Idempotent : ignore les IDs déjà présents.
const addParticipants = async (req, res) => {
  try {
    const { id } = req.params;
    const { participantIDs } = req.body;
    const alanyaID = req.user.alanyaID;

    if (!participantIDs || !Array.isArray(participantIDs) || participantIDs.length === 0) {
      return res.status(400).json({ error: 'participantIDs required as array' });
    }

    // Vérifier que la conv est bien un groupe et que l'appelant est membre.
    const [convRows] = await pool.execute(
      `SELECT c.isGroup FROM conversation c
       JOIN conv_participants cp ON cp.conversID = c.conversID AND cp.alanyaID = ?
       WHERE c.conversID = ?`,
      [alanyaID, id]
    );
    if (convRows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée' });
    }
    if (!convRows[0].isGroup) {
      return res.status(400).json({ error: 'Pas un groupe' });
    }

    // IDs déjà présents → on les filtre pour ne pas violer la PK.
    const [existing] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ?',
      [id]
    );
    const existingIds = new Set(existing.map((r) => Number(r.alanyaID)));

    const toAdd = participantIDs
      .map((p) => parseInt(p, 10))
      .filter((p) => !isNaN(p) && !existingIds.has(p));

    for (const pid of toAdd) {
      await pool.execute(
        'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
        [id, pid]
      );
    }

    // Conv enrichie pour la réponse + diffusion temps réel à tous les membres
    // (existants + nouveaux). Les clients upsertent et voient la liste des
    // participants mise à jour.
    const [rows] = await pool.execute(
      `SELECT c.*, cp.unreadCount, cp.isPinned, cp.isArchived
       FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID
       WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [id, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);

    const io = req.app.get('io');
    if (io) {
      const allMemberIds = [...existingIds, ...toAdd];
      for (const pid of allMemberIds) {
        io.to(`user_${parseInt(pid)}`).emit('conversation:created', enriched);
      }
    }

    res.json(enriched);
  } catch (error) {
    throw error;
  }
};

const leaveGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    await pool.execute('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [id, alanyaID]);

    const [remaining] = await pool.execute('SELECT * FROM conv_participants WHERE conversID = ?', [id]);

    if (remaining.length === 0) {
      await pool.execute('DELETE FROM message WHERE conversationID = ?', [id]);
      await pool.execute('DELETE FROM conversation WHERE conversID = ?', [id]);
    }

    res.json({ message: 'Left group' });
  } catch (error) {
    throw error;
  }
};

const _normalizeConversationIDs = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const ids = [...new Set(raw.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
  return ids.length === raw.length ? ids : [];
};

const batchUpdateConversations = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { conversationIDs, isPinned, isArchived } = req.body;
    const alanyaID = req.user.alanyaID;
    const ids = _normalizeConversationIDs(conversationIDs);

    if (ids.length === 0) {
      return res.status(400).json({ error: 'conversationIDs invalides ou dupliqués' });
    }
    if (ids.length > MAX_BATCH_CONVERSATIONS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_CONVERSATIONS} conversations` });
    }

    const hasPinned = typeof isPinned === 'number' || typeof isPinned === 'boolean';
    const hasArchived = typeof isArchived === 'number' || typeof isArchived === 'boolean';
    if (!hasPinned && !hasArchived) {
      return res.status(400).json({ error: 'Aucune mise à jour fournie (isPinned/isArchived)' });
    }

    const placeholders = ids.map(() => '?').join(',');
    await conn.beginTransaction();

    const [members] = await conn.execute(
      `SELECT conversID FROM conv_participants
       WHERE alanyaID = ? AND conversID IN (${placeholders})`,
      [alanyaID, ...ids]
    );
    if (members.length !== ids.length) {
      await conn.rollback();
      return res.status(403).json({ error: 'Non autorisé pour une ou plusieurs conversations' });
    }

    if (hasPinned) {
      const pinned = isPinned === true || isPinned === 1 ? 1 : 0;
      await conn.execute(
        `UPDATE conv_participants
         SET isPinned = ?
         WHERE alanyaID = ? AND conversID IN (${placeholders})`,
        [pinned, alanyaID, ...ids]
      );
    }
    if (hasArchived) {
      const archived = isArchived === true || isArchived === 1 ? 1 : 0;
      await conn.execute(
        `UPDATE conv_participants
         SET isArchived = ?
         WHERE alanyaID = ? AND conversID IN (${placeholders})`,
        [archived, alanyaID, ...ids]
      );
    }

    await conn.commit();
    res.json({ updated: ids.length });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const batchDeleteConversations = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { conversationIDs } = req.body;
    const alanyaID = req.user.alanyaID;
    const ids = _normalizeConversationIDs(conversationIDs);

    if (ids.length === 0) {
      return res.status(400).json({ error: 'conversationIDs invalides ou dupliqués' });
    }
    if (ids.length > MAX_BATCH_CONVERSATIONS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_CONVERSATIONS} conversations` });
    }

    const placeholders = ids.map(() => '?').join(',');
    await conn.beginTransaction();

    const [members] = await conn.execute(
      `SELECT conversID FROM conv_participants
       WHERE alanyaID = ? AND conversID IN (${placeholders})`,
      [alanyaID, ...ids]
    );
    if (members.length !== ids.length) {
      await conn.rollback();
      return res.status(403).json({ error: 'Non autorisé pour une ou plusieurs conversations' });
    }

    await conn.execute(
      `DELETE FROM conv_participants
       WHERE alanyaID = ? AND conversID IN (${placeholders})`,
      [alanyaID, ...ids]
    );

    const [orphans] = await conn.execute(
      `SELECT c.conversID
       FROM conversation c
       LEFT JOIN conv_participants cp ON cp.conversID = c.conversID
       WHERE c.conversID IN (${placeholders})
       GROUP BY c.conversID
       HAVING COUNT(cp.alanyaID) = 0`,
      ids
    );
    const orphanIDs = orphans.map((r) => Number(r.conversID)).filter((id) => id > 0);
    if (orphanIDs.length > 0) {
      const orphanPlaceholders = orphanIDs.map(() => '?').join(',');
      await conn.execute(
        `DELETE FROM message WHERE conversationID IN (${orphanPlaceholders})`,
        orphanIDs
      );
      await conn.execute(
        `DELETE FROM conversation WHERE conversID IN (${orphanPlaceholders})`,
        orphanIDs
      );
    }

    await conn.commit();
    res.json({ deleted: ids.length });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

module.exports = {
  getConversations,
  getConversationById,
  createConversation,
  createGroup,
  updateConversation,
  deleteConversation,
  markAsRead,
  leaveGroup,
  addParticipants,
  batchUpdateConversations,
  batchDeleteConversations,
};