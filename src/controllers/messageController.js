const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const { notifyNewMessage } = require('../services/notificationService');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { resolveReplyToID } = require('../utils/resolveReplyToID');

const MESSAGE_EDIT_WINDOW_MINUTES = 30;

/// Supprime physiquement un fichier média à partir de son URL publique
/// (`.../uploads/images/x.jpg` ou `.../uploads/media/<sous-dossier>/x`).
/// Best-effort : toute erreur est ignorée (fichier déjà absent, etc.).
const deleteMediaFile = (mediaUrl) => {
  try {
    if (!mediaUrl) return;
    const marker = '/uploads/';
    const idx = mediaUrl.indexOf(marker);
    if (idx === -1) return;
    const relative = mediaUrl.substring(idx + marker.length);
    const filePath = path.join(__dirname, '../../uploads', relative);
    fs.unlink(filePath, () => {});
  } catch (_) {
    /* ignore */
  }
};

const getMessages = async (req, res) => {
  try {
    const { id } = req.params; // conversationID
    const alanyaID = req.user.alanyaID;
    const { limit = 50, before } = req.query;

    let query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar,
             (m.viewedAt IS NOT NULL) AS viewedByMe
      FROM message m
      JOIN users u ON m.senderID = u.alanyaID
      WHERE m.conversationID = ?
        AND m.isDeleted = 0
        AND (m.deletedForID IS NULL OR m.deletedForID != ?)
        AND NOT EXISTS (
          SELECT 1 FROM blocked b
          WHERE b.alanyaID = ?
            AND b.idCallerBlock = m.senderID
            AND m.senderID != ?
            AND m.sendAt >= b.dateBlock
        )
    `;
    const params = [id, alanyaID, alanyaID, alanyaID];

    if (before) {
      query += ' AND m.msgID < ?';
      params.push(parseInt(before));
    }

    query += ' ORDER BY m.sendAt DESC LIMIT ?';
    params.push(parseInt(limit) || 50);

    const [rows] = await pool.query(query, params);

    // Média vue unique déjà consulté par cet utilisateur → on n'expose plus l'URL.
    for (const r of rows) {
      if (r.isViewOnce && r.viewedByMe > 0 && r.senderID !== alanyaID) {
        r.mediaUrl = null;
      }
    }

    await pool.execute(
      `UPDATE message SET status = 3, readAt = NOW()
       WHERE conversationID = ? AND senderID != ? AND status < 3`,
      [id, alanyaID]
    );
    await pool.execute(
      'UPDATE conv_participants SET unreadCount = 0 WHERE conversID = ? AND alanyaID = ?',
      [id, alanyaID]
    );

    res.json(rows.reverse());
  } catch (error) {
    throw error;
  }
};

const _persistAndDeliverMessage = async (req, conversationID, senderID, fields) => {
  const {
    content, type = 0, mediaUrl, mediaName, mediaDuration,
    replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
  } = fields;

  const blockEval = await evaluateDirectMessageSend(conversationID, senderID);
  if (blockEval.isDirect && blockEval.action === 'reject') {
    const err = new Error('Cannot message blocked user');
    err.status = 403;
    err.code = blockEval.code || 'BLOCKED_BY_SENDER';
    throw err;
  }

  const silentDrop = blockEval.isDirect && blockEval.action === 'silent';

  const resolvedReplyToID = await resolveReplyToID(conversationID, replyToID);
  const resolvedReplyToContent = resolvedReplyToID != null ? (replyToContent ?? null) : null;

  const [result] = await pool.execute(
    `INSERT INTO message
       (senderID, conversationID, content, type, status, sendAt,
        mediaUrl, mediaName, mediaDuration, replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce)
     VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      senderID, conversationID, content ?? null, type,
      mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null,
      resolvedReplyToID, resolvedReplyToContent, isStatusReply,
      isForwarded ? 1 : 0, isViewOnce ? 1 : 0,
    ]
  );

  const msgID = result.insertId;

  if (!silentDrop) {
    await pool.execute(
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = NOW(),
           lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
       WHERE conversID = ?`,
      [
        resolveLastMessagePreview({ content, mediaName, type, isViewOnce }),
        senderID, type, conversationID,
      ]
    );

    await pool.execute(
      'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
  }

  const [rows] = await pool.execute(
    `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar
     FROM message m
     JOIN users u ON m.senderID = u.alanyaID
     WHERE m.msgID = ?`,
    [msgID]
  );

  const msg = rows[0];

  if (!silentDrop) {
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationID}`).emit('message:received', msg);

      const userSockets = req.app.get('userSockets');
      if (userSockets) {
        const [participants] = await pool.execute(
          'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
          [conversationID, senderID]
        );
        for (const p of participants) {
          const sid = userSockets.get(p.alanyaID);
          if (sid) io.to(sid).emit('message:received', msg);
          io.to(`user_${p.alanyaID}`).emit('message:received', msg);
        }
      }
    }

    const [sender] = await pool.execute(
      'SELECT nom FROM users WHERE alanyaID = ?', [senderID]
    );
    const senderName = sender[0]?.nom ?? 'Talky';

    const [convRows] = await pool.execute(
      'SELECT isGroup, GroupName FROM conversation WHERE conversID = ?',
      [conversationID]
    );
    const conv = convRows[0] ?? {};
    await notifyNewMessage(conversationID, senderID, senderName, {
      content,
      mediaName,
      type,
      isViewOnce,
      isGroup: !!conv.isGroup,
      groupName: conv.GroupName ?? '',
    });
  }

  return { msg, silentDrop };
};

const sendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      content, type = 0, mediaUrl, mediaName, mediaDuration,
      replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
    } = req.body;
    const senderID = req.user.alanyaID;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'content ou mediaUrl requis' });
    }

    const { msg } = await _persistAndDeliverMessage(req, id, senderID, {
      content, type, mediaUrl, mediaName, mediaDuration,
      replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce,
    });

    res.json(msg);
  } catch (error) {
    if (error.status === 403) {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    throw error;
  }
};

const updateMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const senderID = req.user.alanyaID;

    if (!content) {
      return res.status(400).json({ error: 'content requis' });
    }

    const [existing] = await pool.execute(
      'SELECT * FROM message WHERE msgID = ? AND senderID = ? AND isDeleted = 0',
      [id, senderID]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou non autorisé' });
    }

    const sentAt = new Date(existing[0].sendAt);
    const ageMinutes = (Date.now() - sentAt.getTime()) / 60000;
    if (ageMinutes > MESSAGE_EDIT_WINDOW_MINUTES) {
      return res.status(403).json({
        error: `La modification n'est possible que dans les ${MESSAGE_EDIT_WINDOW_MINUTES} minutes suivant l'envoi`,
      });
    }

    await pool.execute(
      'UPDATE message SET content = ?, isEdited = 1, editedAt = NOW() WHERE msgID = ?',
      [content, id]
    );

    const [rows] = await pool.execute('SELECT * FROM message WHERE msgID = ?', [id]);
    const updated = rows[0];

    const io = req.app.get('io');
    if (io && updated) {
      io.to(`conversation_${updated.conversationID}`).emit('message:updated', updated);
    }

    res.json(updated);
  } catch (error) {
    throw error;
  }
};

const deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { all } = req.query;
    const senderID = req.user.alanyaID;

    const [existing] = await pool.execute(
      'SELECT * FROM message WHERE msgID = ? AND senderID = ?',
      [id, senderID]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou non autorisé' });
    }

    if (all === 'true') {
      await pool.execute(
        'UPDATE message SET isDeleted = 1, deletedForID = NULL WHERE msgID = ?',
        [id]
      );
    } else {
      await pool.execute(
        'UPDATE message SET deletedForID = ? WHERE msgID = ?',
        [senderID, id]
      );
    }

    const io = req.app.get('io');
    if (io && existing[0]) {
      io.to(`conversation_${existing[0].conversationID}`).emit('message:deleted', {
        msgID: parseInt(id),
        conversationID: existing[0].conversationID,
        all: all === 'true',
        deletedForID: all === 'true' ? null : senderID,
      });
    }

    res.json({ message: 'Message supprimé', all: all === 'true' });
  } catch (error) {
    throw error;
  }
};

const pinMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const pinned =
      req.body.isPinned === 1 ||
      req.body.isPinned === true ||
      req.body.isPinned === '1';

    const [existing] = await pool.execute(
      'SELECT conversationID FROM message WHERE msgID = ? AND isDeleted = 0',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable' });
    }
    const conversationID = existing[0].conversationID;

    // L'utilisateur doit être participant de la conversation pour (dés)épingler.
    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversationID, alanyaID]
    );
    if (member.length === 0) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    if (pinned) {
      await pool.execute(
        'UPDATE message SET isPinned = 1, pinnedAt = NOW(), pinnedBy = ? WHERE msgID = ?',
        [alanyaID, id]
      );
    } else {
      await pool.execute(
        'UPDATE message SET isPinned = 0, pinnedAt = NULL, pinnedBy = NULL WHERE msgID = ?',
        [id]
      );
    }

    const payload = {
      msgID: parseInt(id),
      conversationID,
      isPinned: pinned ? 1 : 0,
      pinnedBy: pinned ? alanyaID : null,
    };

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationID}`).emit('message:pinned', payload);
    }

    res.json(payload);
  } catch (error) {
    throw error;
  }
};

const markMessageViewed = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [rows] = await pool.execute(
      'SELECT * FROM message WHERE msgID = ? AND isViewOnce = 1 AND isDeleted = 0',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Média à vue unique introuvable' });
    }
    const msg = rows[0];
    const conversationID = msg.conversationID;

    // L'expéditeur ne « consomme » pas sa propre vue unique.
    if (msg.senderID === alanyaID) {
      return res.json({ msgID: parseInt(id), viewed: false, self: true });
    }

    // L'utilisateur doit être participant.
    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversationID, alanyaID]
    );
    if (member.length === 0) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Vue unique en 1-1 : un seul destinataire ⇒ dès qu'il a vu, on marque
    // consommé et on supprime physiquement le fichier.
    await pool.execute('UPDATE message SET viewedAt = NOW(), mediaUrl = NULL WHERE msgID = ?', [id]);
    deleteMediaFile(msg.mediaUrl);

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationID}`).emit('message:viewed', {
        msgID: parseInt(id),
        conversationID,
        viewerID: alanyaID,
      });
    }

    res.json({ msgID: parseInt(id), viewed: true });
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getMessages,
  sendMessage,
  updateMessage,
  deleteMessage,
  pinMessage,
  markMessageViewed,
};
