const pool = require('../config/db');
const { notifyNewMessage } = require('../services/notificationService');

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
    `;
    const params = [id, alanyaID];

    if (before) {
      query += ' AND m.msgID < ?';
      params.push(parseInt(before));
    }

    query += ' ORDER BY m.sendAt DESC LIMIT ?';
    params.push(parseInt(limit) || 50);
 
    const [rows] = await pool.query(query, params);
    // Marquer comme lus les messages non lus de l'interlocuteur
    await pool.execute(
      `UPDATE message SET status = 3, readAt = NOW()
       WHERE conversationID = ? AND senderID != ? AND status < 3`,
      [id, alanyaID]
    );

    // Remettre unreadCount à 0 pour cet utilisateur
    await pool.execute(
      'UPDATE conv_participants SET unreadCount = 0 WHERE conversID = ? AND alanyaID = ?',
      [id, alanyaID]
    );

    // Les colonnes binaires (ciphertext/archive_blob/dr_nonce) reviennent en
    // Buffer : encodage base64 pour un transport JSON homogène avec le
    // WebSocket. `dr_nonce`/`dr_header` → `nonce`/`header` (mêmes clés que
    // celles envoyées à l'émission, cf. socket/handlers/chat.js).
    for (const row of rows) {
      if (row.ciphertext)   row.ciphertext   = row.ciphertext.toString('base64');
      if (row.archive_blob) row.archive_blob = row.archive_blob.toString('base64');
      row.nonce = row.dr_nonce ? row.dr_nonce.toString('base64') : undefined;
      row.header = row.dr_header ?? undefined;
      delete row.dr_nonce;
      delete row.dr_header;
    }

    res.json(rows.reverse());
  } catch (error) {
    throw error;
  }
};

const sendMessage = async (req, res) => {
  try {
    const { id } = req.params; // conversationID
    const {
      content, type = 0, mediaUrl, mediaName, mediaDuration,
      replyToID, replyToContent, isStatusReply = 0,
      ciphertext, archiveBlob, signalMessageType, nonce, header,
    } = req.body;
    const senderID = req.user.alanyaID;
    const isEncrypted = !!ciphertext;

    if (!content && !mediaUrl && !isEncrypted) {
      return res.status(400).json({ error: 'content, mediaUrl ou ciphertext requis' });
    }

    // Le serveur ne lit jamais l'intérieur de ciphertext/archive_blob/nonce/
    // header : ce sont des données opaques du protocole (voir ARCHITECTURE.md §1).
    const ciphertextBuf  = isEncrypted ? Buffer.from(ciphertext, 'base64') : null;
    const archiveBlobBuf = archiveBlob ? Buffer.from(archiveBlob, 'base64') : null;
    const nonceBuf       = nonce ? Buffer.from(nonce, 'base64') : null;

    const [result] = await pool.execute(
      `INSERT INTO message
         (senderID, conversationID, content, type, status, sendAt,
          mediaUrl, mediaName, mediaDuration, replyToID, replyToContent, isStatusReply,
          ciphertext, archive_blob, signal_message_type, dr_nonce, dr_header)
       VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        senderID, id, isEncrypted ? null : (content ?? null), type,
        mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null,
        replyToID ?? null, replyToContent ?? null, isStatusReply,
        ciphertextBuf, archiveBlobBuf, isEncrypted ? (signalMessageType ?? 2) : null,
        nonceBuf, header ?? null,
      ]
    );

    const msgID = result.insertId;

    // Mettre à jour le résumé de la conversation. Pour un message chiffré,
    // on n'affiche jamais le contenu en clair dans l'aperçu.
    const lastMessagePreview = isEncrypted
      ? '🔒 Message chiffré'
      : (content ? content.substring(0, 200) : (mediaName ?? 'Média'));

    await pool.execute(
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = NOW(),
           lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
       WHERE conversID = ?`,
      [
        lastMessagePreview,
        senderID, type, id,
      ]
    );

    // Incrémenter unreadCount pour tous les autres participants
    await pool.execute(
      'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
      [id, senderID]
    );

    // Récupérer le message complet avec infos sender
    const [rows] = await pool.execute(
      `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar
       FROM message m
       JOIN users u ON m.senderID = u.alanyaID
       WHERE m.msgID = ?`,
      [msgID]
    );

    const msg = rows[0];
    // Les colonnes binaires reviennent en Buffer : encodage base64 pour un
    // transport JSON homogène avec le WebSocket (cf. socket/handlers/chat.js).
    if (msg.ciphertext)   msg.ciphertext   = msg.ciphertext.toString('base64');
    if (msg.archive_blob) msg.archive_blob = msg.archive_blob.toString('base64');
    msg.nonce = msg.dr_nonce ? msg.dr_nonce.toString('base64') : undefined;
    msg.header = msg.dr_header ?? undefined;
    delete msg.dr_nonce;
    delete msg.dr_header;

    // ── Broadcast temps réel via Socket.IO ─────────────────────────────
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${id}`).emit('message:received', msg);

      // Émettre aussi directement aux sockets des participants qui ne
      // sont peut-être pas dans la room (app en arrière-plan mais connectée)
      const userSockets = req.app.get('userSockets');
      if (userSockets) {
        const [participants] = await pool.execute(
          'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
          [id, senderID]
        );
        for (const p of participants) {
          const sid = userSockets.get(p.alanyaID);
          if (sid) io.to(sid).emit('message:received', msg);
        }
      }
    }

    // Notification FCM data-only aux autres participants. Pour un message
    // chiffré, ne jamais transmettre de plaintext : le serveur n'en a de
    // toute façon plus connaissance (content = NULL).
    const [sender] = await pool.execute(
      'SELECT nom FROM users WHERE alanyaID = ?', [senderID]
    );
    const senderName = sender[0]?.nom ?? 'Talky';
    const notifBody = isEncrypted ? '🔒 Message chiffré' : content;
    await notifyNewMessage(id, senderID, senderName, notifBody, type);

    res.json(msg);
  } catch (error) {
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
    const { all } = req.query; // ?all=true → supprimer pour tout le monde
    const senderID = req.user.alanyaID;

    const [existing] = await pool.execute(
      'SELECT * FROM message WHERE msgID = ? AND senderID = ?',
      [id, senderID]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou non autorisé' });
    }

    if (all === 'true') {
      // Supprimer pour tout le monde
      await pool.execute(
        'UPDATE message SET isDeleted = 1, deletedForID = NULL WHERE msgID = ?',
        [id]
      );
    } else {
      // Supprimer uniquement pour moi
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