const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const { notifyNewMessage } = require('../services/notificationService');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { resolveReplyToID } = require('../utils/resolveReplyToID');

const MESSAGE_EDIT_WINDOW_MINUTES = 30;
const MAX_BATCH_DELETE = 50;
const MAX_BATCH_FORWARD_SOURCES = 20;
const MAX_BATCH_FORWARD_TARGETS = 20;

const _execute = (conn, sql, params) =>
  conn ? conn.execute(sql, params) : pool.execute(sql, params);

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
    const { limit = 50, before, after } = req.query;

    const [membership] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [id, alanyaID],
    );
    if (membership.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    let query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar,
             p.timeZone   AS messageTz,
             p.decalageHoraire AS messageTzOffset,
             (m.viewedAt IS NOT NULL) AS viewedByMe
      FROM message m
      JOIN users u ON m.senderID = u.alanyaID
      LEFT JOIN pays p ON u.idPays = p.idPays
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
    if (after) {
      query += ' AND m.msgID > ?';
      params.push(parseInt(after));
    }

    query += ' ORDER BY m.sendAt DESC LIMIT ?';
    params.push(parseInt(limit) || 50);

    const [rows] = await pool.query(query, params);

    // Média vue unique déjà consulté par cet utilisateur → on n'expose plus l'URL.
    // Expose aussi clientId (camelCase) pour le match optimiste côté app.
    for (const r of rows) {
      if (r.isViewOnce && r.viewedByMe > 0 && r.senderID !== alanyaID) {
        r.mediaUrl = null;
      }
      if (r.clientID != null && r.clientId == null) {
        r.clientId = r.clientID;
      }
    }

    // Lecture / accusés : uniquement via message:read ou POST /:id/read
    // (markConversationReadBy), pour notifier lastMessageStatus correctement.

    res.json(rows.reverse());
  } catch (error) {
    throw error;
  }
};

const _deliverMessage = async (req, conversationID, senderID, msg, fields, silentDrop) => {
  if (silentDrop) return;

  const { content, mediaName, type, isViewOnce } = fields;
  const io = req.app.get('io');
  if (io) {
    const [participants] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
    for (const p of participants) {
      io.to(`user_${p.alanyaID}`).emit('message:received', msg);
    }
    if (senderID) {
      const clientId = msg.clientID ?? msg.clientId ?? null;
      io.to(`user_${senderID}`).emit('message:sent', {
        ...msg,
        clientId,
        clientID: clientId,
        msgID: msg.msgID,
      });
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
  }, io);
};

const _persistMessage = async (conn, conversationID, senderID, fields) => {
  const {
    content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb,
    mediaSize, mediaPageCount,
    replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
    clickSentAt,
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

  const [result] = await _execute(conn, 
    `INSERT INTO message
       (senderID, conversationID, content, type, status, sendAt,
        clickSentAt,
        mediaUrl, mediaName, mediaDuration, mediaThumb, mediaSize, mediaPageCount,
        replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce)
     VALUES (?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      senderID, conversationID, content ?? null, type,
      clickSentAt ? new Date(clickSentAt) : null,
      mediaUrl ?? null, mediaName ?? null, mediaDuration ?? null, mediaThumb ?? null,
      mediaSize ?? null, mediaPageCount ?? null,
      resolvedReplyToID, resolvedReplyToContent, isStatusReply,
      isForwarded ? 1 : 0, isViewOnce ? 1 : 0,
    ]
  );

  const msgID = result.insertId;

  if (!silentDrop) {
    await _execute(conn,
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = NOW(),
           lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
       WHERE conversID = ?`,
      [
        resolveLastMessagePreview({ content, mediaName, type, isViewOnce }),
        senderID, type, conversationID,
      ]
    );

    await _execute(conn,
      'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
  }

  const [rows] = await _execute(conn,
    `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
            p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset
     FROM message m
     JOIN users u ON m.senderID = u.alanyaID
     LEFT JOIN pays p ON u.idPays = p.idPays
     WHERE m.msgID = ?`,
    [msgID]
  );

  return { msg: rows[0], silentDrop, fields: { content, mediaName, type, isViewOnce } };
};

const _persistAndDeliverMessage = async (req, conversationID, senderID, fields, { conn = null, skipDelivery = false } = {}) => {
  const { msg, silentDrop, fields: deliveryFields } = await _persistMessage(conn, conversationID, senderID, fields);
  if (!skipDelivery) {
    await _deliverMessage(req, conversationID, senderID, msg, deliveryFields, silentDrop);
  }
  return { msg, silentDrop, deliveryFields };
};

const sendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      content, type = 0, mediaUrl, mediaName, mediaDuration,
      mediaSize, mediaPageCount,
      replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
      clickSentAt,
    } = req.body;
    const senderID = req.user.alanyaID;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'content ou mediaUrl requis' });
    }

    const { msg } = await _persistAndDeliverMessage(req, id, senderID, {
      content, type, mediaUrl, mediaName, mediaDuration,
      mediaSize, mediaPageCount,
      replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce,
      clickSentAt,
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

const batchDeleteMessages = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { msgIDs, all } = req.body;
    const senderID = req.user.alanyaID;
    const forAll = all === true || all === 1 || all === '1' || all === 'true';

    if (!Array.isArray(msgIDs) || msgIDs.length === 0) {
      return res.status(400).json({ error: 'msgIDs requis (tableau non vide)' });
    }
    if (msgIDs.length > MAX_BATCH_DELETE) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_DELETE} messages par requête` });
    }

    const ids = [...new Set(msgIDs.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    if (ids.length !== msgIDs.length) {
      return res.status(400).json({ error: 'msgIDs invalides ou dupliqués' });
    }

    await conn.beginTransaction();

    const placeholders = ids.map(() => '?').join(',');
    const [existing] = await conn.execute(
      `SELECT msgID, conversationID, senderID FROM message WHERE msgID IN (${placeholders})`,
      ids
    );

    if (existing.length !== ids.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Un ou plusieurs messages introuvables' });
    }

    const unauthorized = existing.some((row) => row.senderID !== senderID);
    if (unauthorized) {
      await conn.rollback();
      return res.status(403).json({ error: 'Non autorisé pour un ou plusieurs messages' });
    }

    if (forAll) {
      await conn.execute(
        `UPDATE message SET isDeleted = 1, deletedForID = NULL WHERE msgID IN (${placeholders})`,
        ids
      );
    } else {
      await conn.execute(
        `UPDATE message SET deletedForID = ? WHERE msgID IN (${placeholders})`,
        [senderID, ...ids]
      );
    }

    await conn.commit();

    const byConversation = new Map();
    for (const row of existing) {
      const convId = row.conversationID;
      if (!byConversation.has(convId)) byConversation.set(convId, []);
      byConversation.get(convId).push(row.msgID);
    }

    const io = req.app.get('io');
    if (io) {
      for (const [conversationID, convMsgIDs] of byConversation) {
        io.to(`conversation_${conversationID}`).emit('messages:deleted', {
          conversationID,
          msgIDs: convMsgIDs,
          all: forAll,
          deletedForID: forAll ? null : senderID,
        });
      }
    }

    res.json({ deleted: ids.length, all: forAll });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const batchForwardMessages = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { sourceMsgIDs, targetConversationIDs, caption } = req.body;
    const senderID = req.user.alanyaID;

    if (!Array.isArray(sourceMsgIDs) || sourceMsgIDs.length === 0) {
      return res.status(400).json({ error: 'sourceMsgIDs requis (tableau non vide)' });
    }
    if (!Array.isArray(targetConversationIDs) || targetConversationIDs.length === 0) {
      return res.status(400).json({ error: 'targetConversationIDs requis (tableau non vide)' });
    }
    if (sourceMsgIDs.length > MAX_BATCH_FORWARD_SOURCES) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_FORWARD_SOURCES} messages source` });
    }
    if (targetConversationIDs.length > MAX_BATCH_FORWARD_TARGETS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_FORWARD_TARGETS} conversations cibles` });
    }

    const sourceIds = [...new Set(sourceMsgIDs.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    const targetIds = [...new Set(targetConversationIDs.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    if (sourceIds.length !== sourceMsgIDs.length || targetIds.length !== targetConversationIDs.length) {
      return res.status(400).json({ error: 'IDs invalides ou dupliqués' });
    }

    const sourcePlaceholders = sourceIds.map(() => '?').join(',');
    const [sources] = await pool.execute(
      `SELECT * FROM message WHERE msgID IN (${sourcePlaceholders}) ORDER BY FIELD(msgID, ${sourcePlaceholders})`,
      [...sourceIds, ...sourceIds]
    );

    if (sources.length !== sourceIds.length) {
      return res.status(404).json({ error: 'Un ou plusieurs messages source introuvables' });
    }

    const sourceConversationID = sources[0].conversationID;
    if (!sources.every((m) => m.conversationID === sourceConversationID)) {
      return res.status(400).json({ error: 'Tous les messages source doivent être dans la même conversation' });
    }

    const [sourceMember] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [sourceConversationID, senderID]
    );
    if (sourceMember.length === 0) {
      return res.status(403).json({ error: 'Non autorisé à lire les messages source' });
    }

    for (const m of sources) {
      if (m.isDeleted) {
        return res.status(400).json({ error: 'Message supprimé non transférable' });
      }
      if (m.isViewOnce) {
        return res.status(400).json({ error: 'Média à vue unique non transférable' });
      }
      if (m.type !== 0 && m.type !== 5 && !m.mediaUrl) {
        return res.status(400).json({ error: 'Média sans URL serveur non transférable via batch' });
      }
    }

    for (const targetId of targetIds) {
      const [member] = await pool.execute(
        'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
        [targetId, senderID]
      );
      if (member.length === 0) {
        return res.status(403).json({ error: `Non autorisé pour la conversation ${targetId}` });
      }
    }

    await conn.beginTransaction();

    const pendingDelivery = [];
    const createdMessages = [];
    const trimmedCaption = typeof caption === 'string' ? caption.trim() : '';

    for (const targetId of targetIds) {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        let content = source.content ?? null;
        if (i === 0 && trimmedCaption) {
          content = trimmedCaption;
        } else if (i === 0 && source.type !== 0 && trimmedCaption === '') {
          content = source.content ?? null;
        }

        const { msg, silentDrop, deliveryFields } = await _persistAndDeliverMessage(
          req,
          targetId,
          senderID,
          {
            content,
            type: source.type,
            mediaUrl: source.mediaUrl,
            mediaName: source.mediaName,
            mediaDuration: source.mediaDuration,
            mediaSize: source.mediaSize,
            mediaPageCount: source.mediaPageCount,
            isForwarded: 1,
          },
          { conn, skipDelivery: true }
        );

        createdMessages.push(msg);
        if (!silentDrop) {
          pendingDelivery.push({
            conversationID: targetId,
            msg,
            deliveryFields,
            silentDrop,
          });
        }
      }
    }

    await conn.commit();

    for (const item of pendingDelivery) {
      await _deliverMessage(
        req,
        item.conversationID,
        senderID,
        item.msg,
        item.deliveryFields,
        item.silentDrop
      );
    }

    res.json({ forwarded: createdMessages.length, messages: createdMessages });
  } catch (error) {
    await conn.rollback();
    if (error.status === 403) {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    conn.release();
  }
};

/**
 * Sync delta globale multi-conversations basée sur un curseur PAR conversation.
 *
 * Le client envoie `cursors: [{c: conversID, m: dernierMsgIDLocal}, ...]` pour
 * les conversations qu'il connaît déjà (m > 0). Le serveur renvoie tous les
 * messages `msgID > curseur` de CES conversations, triés par msgID ASC et
 * plafonnés (`limit`). Le client réitère (en reconstruisant les curseurs depuis
 * son local) tant que `hasMore` est vrai → rattrapage garanti et sans trou,
 * indépendamment de la fiabilité du WebSocket.
 *
 * Curseur PAR conversation (et non global) : sinon, être à jour dans une conv
 * (msgID élevé) masquerait d'anciens messages manquants d'une autre conv.
 */
const getMessagesSince = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const rawCursors = Array.isArray(req.body?.cursors) ? req.body.cursors : [];
    const limit = Math.min(parseInt(req.body?.limit, 10) || 300, 500);

    // Normalise + déduplique (garde le plus petit curseur si doublon, pour ne
    // rien rater), en ne conservant que des entrées valides.
    const cursorByConv = new Map();
    for (const entry of rawCursors) {
      const c = parseInt(entry?.c, 10);
      const m = parseInt(entry?.m, 10);
      if (!Number.isInteger(c) || c <= 0) continue;
      const cur = Number.isInteger(m) && m > 0 ? m : 0;
      if (!cursorByConv.has(c) || cur < cursorByConv.get(c)) {
        cursorByConv.set(c, cur);
      }
    }

    if (cursorByConv.size === 0) {
      return res.json({ messages: [], hasMore: false });
    }

    // Clauses OR (conversationID = ? AND msgID > ?) — bornées par participation.
    const orClauses = [];
    const orParams = [];
    for (const [c, m] of cursorByConv.entries()) {
      orClauses.push('(m.conversationID = ? AND m.msgID > ?)');
      orParams.push(c, m);
    }

    const query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar,
             p.timeZone   AS messageTz,
             p.decalageHoraire AS messageTzOffset,
             (m.viewedAt IS NOT NULL) AS viewedByMe
      FROM message m
      JOIN conv_participants cp ON cp.conversID = m.conversationID AND cp.alanyaID = ?
      JOIN users u ON m.senderID = u.alanyaID
      LEFT JOIN pays p ON u.idPays = p.idPays
      WHERE m.isDeleted = 0
        AND (m.deletedForID IS NULL OR m.deletedForID != ?)
        AND NOT EXISTS (
          SELECT 1 FROM blocked b
          WHERE b.alanyaID = ?
            AND b.idCallerBlock = m.senderID
            AND m.senderID != ?
            AND m.sendAt >= b.dateBlock
        )
        AND (${orClauses.join(' OR ')})
      ORDER BY m.msgID ASC
      LIMIT ?
    `;
    const params = [alanyaID, alanyaID, alanyaID, alanyaID, ...orParams, limit + 1];
    const [rows] = await pool.query(query, params);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    for (const r of page) {
      if (r.isViewOnce && r.viewedByMe > 0 && r.senderID !== alanyaID) {
        r.mediaUrl = null;
      }
      if (r.clientID != null && r.clientId == null) {
        r.clientId = r.clientID;
      }
    }

    res.json({ messages: page, hasMore });
  } catch (error) {
    throw error;
  }
};

/** Statut d'un message envoyé par clientId (rattrapage outbox HTTP). */
const getMessageStatusByClientId = async (req, res) => {
  try {
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
    if (!clientId) {
      return res.status(400).json({ error: 'clientId required' });
    }

    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT msgID, status, conversationID, sendAt, clientID
       FROM message
       WHERE clientID = ? AND senderID = ? AND isDeleted = 0
       LIMIT 1`,
      [clientId, alanyaID],
    );

    if (rows.length === 0) {
      return res.json({ found: false });
    }

    const row = rows[0];
    res.json({
      found: true,
      msgID: row.msgID,
      status: row.status,
      conversationID: row.conversationID,
      sendAt: row.sendAt,
      clientId: row.clientID,
    });
  } catch (error) {
    throw error;
  }
};

/** Messages sortants encore au statut « envoyé » (status=1) pour réconciliation outbox. */
const getPendingOutgoingMessages = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT msgID, clientID, conversationID, content, type, sendAt, status
       FROM message
       WHERE senderID = ? AND status = 1 AND isDeleted = 0
       ORDER BY sendAt DESC
       LIMIT 50`,
      [alanyaID],
    );

    const messages = rows.map((row) => ({
      ...row,
      clientId: row.clientID,
    }));
    res.json({ messages });
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getMessages,
  getMessagesSince,
  sendMessage,
  updateMessage,
  deleteMessage,
  batchDeleteMessages,
  batchForwardMessages,
  pinMessage,
  markMessageViewed,
  getMessageStatusByClientId,
  getPendingOutgoingMessages,
};
