const pool = require('../config/db');
const { notifyStatusView } = require('../services/notificationService');
const {
  getAudienceForAuthor,
  emitToUsers,
  emitToUser,
} = require('../services/statusSocketService');

// ── GET /api/status ─────────────────────────────────────────────────
// Statuts actifs des auteurs avec lesquels j'ai un lien "favori réciproque" :
// l'auteur m'a en contact préféré ET je l'ai en contact préféré.
const getStatus = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    const [rows] = await pool.execute(
      `SELECT s.*,
              u.nom, u.pseudo, u.avatar_url, u.is_online,
              EXISTS(
                SELECT 1 FROM statut_views sv
                WHERE sv.statutID = s.ID AND sv.alanyaID = ? AND sv.liked = 1
              ) AS likedByMe,
              EXISTS(
                SELECT 1 FROM statut_views sv2
                WHERE sv2.statutID = s.ID AND sv2.alanyaID = ?
              ) AS seenByMe
       FROM statut s
       JOIN users u              ON s.alanyaID = u.alanyaID
       JOIN preferredContact pc1 ON pc1.alanyaID = s.alanyaID AND pc1.idFriend = ?
       JOIN preferredContact pc2 ON pc2.alanyaID = ?           AND pc2.idFriend = s.alanyaID
       WHERE s.expiredAt > NOW()
         AND s.alanyaID != ?
         AND NOT EXISTS (
           SELECT 1 FROM blocked b
           WHERE b.alanyaID = s.alanyaID AND b.idCallerBlock = ?
         )
       ORDER BY s.alanyaID, s.createdAt ASC
       LIMIT 500`,
      [alanyaID, alanyaID, alanyaID, alanyaID, alanyaID, alanyaID]
    );

    res.json(rows);
  } catch (error) {
    throw error;
  }
};

// ── GET /api/status/me ──────────────────────────────────────────────
const getMyStatus = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT s.*, u.nom, u.pseudo, u.avatar_url, u.is_online
       FROM statut s
       JOIN users u ON s.alanyaID = u.alanyaID
       WHERE s.alanyaID = ? AND s.expiredAt > NOW()
       ORDER BY s.createdAt ASC`,
      [alanyaID]
    );
    res.json(rows);
  } catch (error) {
    throw error;
  }
};

// ── GET /api/status/:id/views ──────────────────────────────────────
const getStatusViews = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [owner] = await pool.execute(
      'SELECT alanyaID FROM statut WHERE ID = ?', [id]
    );
    if (owner.length === 0 || owner[0].alanyaID !== alanyaID) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    const [rows] = await pool.execute(
      `SELECT sv.statutID, sv.alanyaID, sv.seenAt, sv.liked, sv.likedAt,
              u.nom, u.pseudo, u.avatar_url
       FROM statut_views sv
       JOIN users u ON sv.alanyaID = u.alanyaID
       WHERE sv.statutID = ?
       ORDER BY sv.liked DESC, sv.seenAt DESC`,
      [id]
    );

    res.json(rows);
  } catch (error) {
    throw error;
  }
};

// ── POST /api/status ───────────────────────────────────────────────
const createStatus = async (req, res) => {
  try {
    const {
      text,
      mediaUrl,
      backgroundColor,
      type = 0,
      mediaDurationMs,
    } = req.body;
    const alanyaID = req.user.alanyaID;

    if (!text && !mediaUrl) {
      return res.status(400).json({ error: 'text ou mediaUrl requis' });
    }

    const [result] = await pool.execute(
      `INSERT INTO statut (alanyaID, type, text, mediaUrl, mediaDurationMs,
                           backgroundColor, createdAt, expiredAt, viewedBy, likedBy)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR), 0, 0)`,
      [
        alanyaID,
        type,
        text ?? '',
        mediaUrl ?? null,
        mediaDurationMs ?? null,
        backgroundColor ?? null,
      ]
    );

    const [rows] = await pool.execute(
      `SELECT s.*, u.nom, u.pseudo, u.avatar_url, u.is_online
       FROM statut s JOIN users u ON s.alanyaID = u.alanyaID
       WHERE s.ID = ?`,
      [result.insertId]
    );
    const created = rows[0];

    // Broadcast à l'audience (ceux qui m'ont en contact préféré)
    const io = req.app.get('io');
    const audience = await getAudienceForAuthor(alanyaID);
    emitToUsers(io, audience, 'status:created', created);

    res.json(created);
  } catch (error) {
    throw error;
  }
};

// ── DELETE /api/status/:id ─────────────────────────────────────────
const deleteStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [result] = await pool.execute(
      'DELETE FROM statut WHERE ID = ? AND alanyaID = ?',
      [id, alanyaID]
    );

    if (result.affectedRows > 0) {
      const io = req.app.get('io');
      const audience = await getAudienceForAuthor(alanyaID);
      emitToUsers(io, audience, 'status:deleted', {
        ID: Number(id),
        alanyaID,
      });
    }

    res.json({ message: 'Statut supprimé' });
  } catch (error) {
    throw error;
  }
};

// ── POST /api/status/:id/view ──────────────────────────────────────
const viewStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [statut] = await pool.execute(
      'SELECT * FROM statut WHERE ID = ? AND expiredAt > NOW()',
      [id]
    );
    if (statut.length === 0) {
      return res.status(404).json({ error: 'Statut introuvable ou expiré' });
    }

    // Tente l'INSERT — la contrainte UNIQUE empêche les doublons
    const [ins] = await pool.execute(
      'INSERT IGNORE INTO statut_views (statutID, alanyaID, seenAt) VALUES (?, ?, NOW())',
      [id, alanyaID]
    );

    if (ins.affectedRows > 0) {
      await pool.execute(
        'UPDATE statut SET viewedBy = viewedBy + 1 WHERE ID = ?',
        [id]
      );

      // Émit temps réel à l'auteur + push FCM
      const ownerID = statut[0].alanyaID;
      if (ownerID !== alanyaID) {
        const [viewer] = await pool.execute(
          'SELECT alanyaID, nom, pseudo, avatar_url FROM users WHERE alanyaID = ?',
          [alanyaID]
        );
        const v = viewer[0] ?? { nom: 'Quelqu\'un' };

        const io = req.app.get('io');
        emitToUser(io, ownerID, 'status:viewed', {
          statutID: Number(id),
          viewer: {
            alanyaID: v.alanyaID,
            nom: v.nom,
            pseudo: v.pseudo,
            avatar_url: v.avatar_url,
          },
          seenAt: new Date().toISOString(),
        });

        await notifyStatusView(ownerID, v.nom || 'Quelqu\'un');
      }
    }

    // État actuel du like pour ce viewer
    const [liked] = await pool.execute(
      'SELECT liked FROM statut_views WHERE statutID = ? AND alanyaID = ?',
      [id, alanyaID]
    );

    res.json({
      message: 'Statut vu',
      liked: liked[0]?.liked === 1,
    });
  } catch (error) {
    throw error;
  }
};

// ── POST /api/status/:id/like ──────────────────────────────────────
const likeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [statut] = await pool.execute(
      'SELECT alanyaID FROM statut WHERE ID = ? AND expiredAt > NOW()',
      [id]
    );
    if (statut.length === 0) {
      return res.status(404).json({ error: 'Statut introuvable ou expiré' });
    }
    const ownerID = statut[0].alanyaID;

    // État précédent
    const [prev] = await pool.execute(
      'SELECT liked FROM statut_views WHERE statutID = ? AND alanyaID = ?',
      [id, alanyaID]
    );
    const wasLiked = prev[0]?.liked === 1;
    const isNewRow = prev.length === 0;

    await pool.execute(
      `INSERT INTO statut_views (statutID, alanyaID, seenAt, liked, likedAt)
       VALUES (?, ?, NOW(), 1, NOW())
       ON DUPLICATE KEY UPDATE liked = 1, likedAt = NOW()`,
      [id, alanyaID]
    );

    // Si nouvelle ligne : incrémenter le compteur de vues
    if (isNewRow) {
      await pool.execute(
        'UPDATE statut SET viewedBy = viewedBy + 1 WHERE ID = ?',
        [id]
      );
    }
    // Si transition 0→1 : incrémenter likedBy
    if (!wasLiked) {
      await pool.execute(
        'UPDATE statut SET likedBy = likedBy + 1 WHERE ID = ?',
        [id]
      );

      // Émit temps réel à l'auteur (sauf auto-like)
      if (ownerID !== alanyaID) {
        const [viewer] = await pool.execute(
          'SELECT alanyaID, nom, pseudo, avatar_url FROM users WHERE alanyaID = ?',
          [alanyaID]
        );
        const v = viewer[0] ?? {};
        const io = req.app.get('io');
        emitToUser(io, ownerID, 'status:liked', {
          statutID: Number(id),
          viewer: {
            alanyaID: v.alanyaID,
            nom: v.nom,
            pseudo: v.pseudo,
            avatar_url: v.avatar_url,
          },
          likedAt: new Date().toISOString(),
        });
      }
    }

    res.json({ message: 'Statut liké', liked: true });
  } catch (error) {
    throw error;
  }
};

// ── DELETE /api/status/:id/like ────────────────────────────────────
const unlikeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [statut] = await pool.execute(
      'SELECT alanyaID FROM statut WHERE ID = ?',
      [id]
    );
    if (statut.length === 0) {
      return res.status(404).json({ error: 'Statut introuvable' });
    }
    const ownerID = statut[0].alanyaID;

    const [result] = await pool.execute(
      `UPDATE statut_views SET liked = 0, likedAt = NULL
       WHERE statutID = ? AND alanyaID = ? AND liked = 1`,
      [id, alanyaID]
    );

    if (result.affectedRows > 0) {
      await pool.execute(
        'UPDATE statut SET likedBy = GREATEST(likedBy - 1, 0) WHERE ID = ?',
        [id]
      );

      if (ownerID !== alanyaID) {
        const io = req.app.get('io');
        emitToUser(io, ownerID, 'status:unliked', {
          statutID: Number(id),
          alanyaID,
        });
      }
    }

    res.json({ message: 'Statut unliké', liked: false });
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getStatus,
  getMyStatus,
  getStatusViews,
  createStatus,
  deleteStatus,
  viewStatus,
  likeStatus,
  unlikeStatus,
};
