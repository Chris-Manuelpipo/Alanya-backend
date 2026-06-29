const pool = require('../config/db');
const { notifyNewMessage } = require('../services/notificationService');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');

const MESSAGE_EDIT_WINDOW_MINUTES = 30;

const getMessages = async (req, res) => {
  try {
    const { id } = req.params; // conversationID
    const alanyaID = req.user.alanyaID;
    const { limit = 50, before } = req.query;

    let query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar
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
    replyToID, replyToContent, isStatusReply = 0,
  } = fields;

  const blockEval = await evaluateDirectMessageSend(conversationID, senderID);
  if (blockEval.isDirect && blockEval.action === 'reject') {
    const err = new Error('Cannot message blocked user');
    err.status = 403;
    err.code = blockEval.code || 'BLOCKED_BY_SENDER';
    throw err;
  }

  const silentDrop = blockEval.isDirect && blockEval.action === 'silent';

  const [result] = await pool.execute(
    `INSERT INTO message
       (senderID, conversationID, content, type, status, sendAt,
        mediaUrl, mediaName, mediaDuration, replyToID, replyToContent, isStatusReply)
     VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?)`,
    [
      senderID, conversationID, content ?? null, type,
      mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null,
      replyToID ?? null, replyToContent ?? null, isStatusReply,
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
        content ? content.substring(0, 200) : (mediaName ?? 'Média'),
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
    await notifyNewMessage(conversationID, senderID, senderName, content, type);
  }

  return { msg, silentDrop };
};

const sendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      content, type = 0, mediaUrl, mediaName, mediaDuration,
      replyToID, replyToContent, isStatusReply = 0,
    } = req.body;
    const senderID = req.user.alanyaID;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'content ou mediaUrl requis' });
    }

    const { msg } = await _persistAndDeliverMessage(req, id, senderID, {
      content, type, mediaUrl, mediaName, mediaDuration,
      replyToID, replyToContent, isStatusReply,
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

module.exports = {
  getMessages,
  sendMessage,
  updateMessage,
  deleteMessage,
};
