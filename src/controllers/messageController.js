const pool = require('../config/db');
const { deleteMediaFile } = require('../utils/mediaFile');
const { notifyNewMessage } = require('../services/notificationService');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');
const { assertCanSendToConversation } = require('../utils/groupSendPolicy');
const { sanitizeMentions, serializeMentionsColumn } = require('../utils/mentions');
const { markConversationDeliveredBy } = require('../utils/deliveryReceiptUtils');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { resolveReplyToID } = require('../utils/resolveReplyToID');
const { HISTORY_CUTOFF_SQL } = require('../utils/messageHistoryFilter');
const { MESSAGE_INSERT_SQL, messageInsertParams, insertMessageThumb } = require('../utils/messageInsert');

const MESSAGE_EDIT_WINDOW_MINUTES = 30;
const MAX_BATCH_DELETE = 50;
const MAX_BATCH_FORWARD_SOURCES = 20;
const MAX_BATCH_FORWARD_TARGETS = 20;

const _execute = (conn, sql, params) =>
  conn ? conn.execute(sql, params) : pool.execute(sql, params);

const getMessages = async (req, res) => {
  try {
    const { id } = req.params; // conversationID
    const alanyaID = req.user.alanyaID;
    const { limit = 50, before, after } = req.query;

    // Membership d'abord : un JOIN seul renverrait [] pour un non-membre, ce
    // qui confirmerait l'existence de la conversation. 404 comme avant.
    const [membership] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [id, alanyaID],
    );
    if (membership.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Jointure cp : filtre historyCutoffAt (migration 028). Sans elle, un
    // nouvel arrivant avec historique masqué récupérerait tout le fil.
    // mediaThumb rejointe depuis message_thumb, réencodée en base64 : même
    // contrat JSON qu'avant, la vignette n'est simplement plus stockée dans
    // la ligne `message` (audit scalabilité 06/08/2026 §2.2, migration 060).
    let query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar,
             p.timeZone   AS messageTz,
             p.decalageHoraire AS messageTzOffset,
             (m.viewedAt IS NOT NULL) AS viewedByMe,
             TO_BASE64(mt.thumb) AS mediaThumb
      FROM message m
      JOIN conv_participants cp
        ON cp.conversID = m.conversationID AND cp.alanyaID = ?
      JOIN users u ON m.senderID = u.alanyaID
      LEFT JOIN pays p ON u.idPays = p.idPays
      LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
      WHERE m.conversationID = ?
        AND m.isDeleted = 0
        AND (m.deletedForID IS NULL OR m.deletedForID != ?)
        AND ${HISTORY_CUTOFF_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM blocked b
          WHERE b.alanyaID = ?
            AND b.idCallerBlock = m.senderID
            AND m.senderID != ?
            AND m.sendAt >= b.dateBlock
        )
    `;
    const params = [alanyaID, id, alanyaID, alanyaID, alanyaID];

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

/**
 * Ack à l'expéditeur seul. Extrait pour être réutilisé au rejeu, où l'on ne doit
 * ni rediffuser aux autres participants ni renvoyer de push.
 */
const _emitSenderAck = (req, senderID, msg) => {
  const io = req.app.get('io');
  if (!io || !senderID) return;
  const clientId = msg.clientID ?? msg.clientId ?? null;
  io.to(`user_${senderID}`).emit('message:sent', {
    ...msg,
    clientId,
    clientID: clientId,
    msgID: msg.msgID,
  });
};

const _deliverMessage = async (req, conversationID, senderID, msg, fields, silentDrop) => {
  if (silentDrop) return;

  const { content, mediaName, type, isViewOnce, mentions } = fields;
  const io = req.app.get('io');
  if (io) {
    const [participants] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
    if (participants.length > 0) {
      // Forme tableau : une seule émission, encodage unique du payload.
      io.to(participants.map((p) => `user_${p.alanyaID}`))
        .emit('message:received', msg);
    }
    _emitSenderAck(req, senderID, msg);
  }

  // Fan-out FCM hors du cycle de la réponse HTTP (le chemin socket fait déjà
  // pareil via setImmediate) : le client ne doit pas attendre N envois push
  // avant de recevoir son 200, et la connexion pool est libérée tout de suite.
  setImmediate(async () => {
    try {
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
        mentions,
        // Sans eux, `stringifyData` les retirait du payload (clés undefined) : la
        // push d'une réponse rapide partait sans msgID, et la déduplication client
        // retombait sur `eventId`, régénéré à chaque envoi — donc inopérante. Le
        // chemin socket les transmet depuis toujours.
        msgID: msg.msgID,
        clientId: msg.clientID ?? msg.clientId ?? null,
      }, io);
    } catch (e) {
      console.error('[FCM] fan-out HTTP échoué:', e.message);
    }
  });
};

const _persistMessage = async (conn, conversationID, senderID, fields) => {
  const {
    content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb,
    mediaSize, mediaPageCount,
    replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
    clickSentAt, clientId, mentions, mentionsAll = false,
  } = fields;

  if (clientId) {
    const [existing] = await _execute(conn,
      `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
              p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
              TO_BASE64(mt.thumb) AS mediaThumb
       FROM message m
       JOIN users u ON m.senderID = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
       WHERE m.senderID = ? AND m.clientID = ? AND m.isDeleted = 0
       LIMIT 1`,
      [senderID, clientId],
    );
    if (existing.length > 0) {
      return {
        msg: existing[0],
        silentDrop: false,
        // Le message existe déjà : l'appelant ne doit PAS rediffuser. Voir
        // `_persistAndDeliverMessage`.
        replayed: true,
        // Rejeu : on relit les mentions déjà persistées plutôt que de refaire
        // confiance au payload, qui peut avoir changé entre deux tentatives.
        fields: {
          content, mediaName, type, isViewOnce,
          mentions: existing[0].mentions,
        },
      };
    }
  }

  // Appartenance + mode annonce. Placé APRÈS le court-circuit d'idempotence
  // ci-dessus : un message déjà persisté doit rester rejouable même si le mode
  // annonce a été activé entre-temps, sinon un retry légitime échouerait.
  const sendPolicy = await assertCanSendToConversation(conversationID, senderID);
  if (!sendPolicy.ok) {
    const err = new Error(sendPolicy.message);
    err.status = sendPolicy.code === 'CONVERSATION_NOT_FOUND' ? 404 : 403;
    err.code = sendPolicy.code;
    throw err;
  }

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

  const mentionsValue = await sanitizeMentions(
    conversationID, senderID, mentions, { all: mentionsAll === true },
  );

  const [result] = await _execute(
    conn,
    MESSAGE_INSERT_SQL,
    messageInsertParams({
      senderID,
      conversationID,
      clientId,
      content,
      type,
      clickSentAt,
      mediaUrl,
      mediaName,
      mediaDuration,
      mediaSize,
      mediaPageCount,
      replyToID: resolvedReplyToID,
      replyToContent: resolvedReplyToContent,
      isStatusReply,
      isForwarded,
      isViewOnce,
      mentionsSerialized: serializeMentionsColumn(mentionsValue),
    }),
  );

  const msgID = result.insertId;
  // Course : un second POST (rejeu natif / Flutter) a pu gagner l'INSERT.
  // affectedRows === 1 → ligne nouvelle ; sinon c'est un rejeu, on ne
  // touche ni unread ni lastMessage.
  const isNewInsert = result.affectedRows === 1;

  // Écriture séparée dans message_thumb (audit scalabilité 06/08/2026 §2.2,
  // migration 060) : idempotente, sûre à rejouer sur le chemin course.
  await insertMessageThumb(conn ?? pool, msgID, mediaThumb);

  if (!isNewInsert) {
    const [existingRows] = await _execute(
      conn,
      `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
              p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
              TO_BASE64(mt.thumb) AS mediaThumb
       FROM message m
       JOIN users u ON m.senderID = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
       WHERE m.msgID = ?`,
      [msgID],
    );
    return {
      msg: existingRows[0],
      silentDrop: false,
      replayed: true,
      fields: {
        content,
        mediaName,
        type,
        isViewOnce,
        mentions: existingRows[0]?.mentions ?? mentionsValue,
      },
    };
  }

  if (!silentDrop) {
    await _execute(conn,
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = NOW(),
           lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1,
           message_count = message_count + 1
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
            p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
            TO_BASE64(mt.thumb) AS mediaThumb
     FROM message m
     JOIN users u ON m.senderID = u.alanyaID
     LEFT JOIN pays p ON u.idPays = p.idPays
     LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
     WHERE m.msgID = ?`,
    [msgID]
  );

  return {
    msg: rows[0],
    silentDrop,
    replayed: false,
    fields: { content, mediaName, type, isViewOnce, mentions: mentionsValue },
  };
};

const _persistAndDeliverMessage = async (req, conversationID, senderID, fields, { conn = null, skipDelivery = false } = {}) => {
  const { msg, silentDrop, replayed, fields: deliveryFields } =
    await _persistMessage(conn, conversationID, senderID, fields);
  if (!skipDelivery) {
    if (replayed) {
      // Rejeu d'un `clientId` déjà persisté. Rediffuser enverrait un second
      // `message:received` ET une seconde push : le destinataire verrait deux
      // fois le même message. Seul l'ack expéditeur est rejoué, pour que le
      // client qui retente puisse réconcilier sa ligne locale.
      //
      // Même comportement que le chemin socket, qui sort immédiatement dans ce
      // cas (src/socket/handlers/chat/messageSend.js).
      _emitSenderAck(req, senderID, msg);
    } else {
      await _deliverMessage(req, conversationID, senderID, msg, deliveryFields, silentDrop);
    }
  }
  return { msg, silentDrop, replayed, deliveryFields };
};

// `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
// `async`, donc l'erreur remontait en unhandled rejection et tuait le process
// sous Node 24, sans jamais atteindre `errorHandler`. C'est le chemin de la
// réponse rapide depuis la notification, app fermée.
const sendMessage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      content, type = 0, mediaUrl, mediaName, mediaDuration,
      mediaSize, mediaPageCount,
      replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
      clickSentAt, clientId,
    } = req.body;
    const senderID = req.user.alanyaID;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'content ou mediaUrl requis' });
    }

    const { msg } = await _persistAndDeliverMessage(req, id, senderID, {
      content, type, mediaUrl, mediaName, mediaDuration,
      mediaSize, mediaPageCount,
      replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce,
      clickSentAt, clientId,
    });

    res.json(msg);
  } catch (error) {
    // `error.status` et non `=== 403` : la politique d'envoi renvoie aussi un
    // 404 (conversation inexistante), qui finirait sinon en 500.
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    next(error);
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

    // Être l'auteur ne suffit pas : il faut être ENCORE membre. Sans ça, un
    // exclu gardait 30 minutes pour réécrire le contenu de ses messages restés
    // dans le fil du groupe — modification rediffusée aux membres restants — et
    // un temps illimité pour les supprimer pour tout le monde. C'était aussi un
    // contournement du mode annonce : interdit d'envoyer, mais libre de
    // remplacer le texte d'un message antérieur au verrou.
    const [existing] = await pool.execute(
      `SELECT m.* FROM message m
         JOIN conv_participants cp
           ON cp.conversID = m.conversationID AND cp.alanyaID = m.senderID
        WHERE m.msgID = ? AND m.senderID = ? AND m.isDeleted = 0`,
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

    const [rows] = await pool.execute(
      `SELECT m.*, TO_BASE64(mt.thumb) AS mediaThumb
       FROM message m
       LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
       WHERE m.msgID = ?`,
      [id],
    );
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
      if (!existing[0].isDeleted) {
        await pool.execute(
          'UPDATE message SET isDeleted = 1, deletedForID = NULL WHERE msgID = ?',
          [id],
        );
        await pool.execute(
          'UPDATE conversation SET message_count = GREATEST(0, message_count - 1) WHERE conversID = ?',
          [existing[0].conversationID],
        );
      }
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

/// Parse la colonne JSON `message.reactions` (tableau [{ userID, emoji, reactedAt }]).
const _parseReactionsColumn = (raw) => {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const _upsertUserReaction = (reactions, userID, emoji) => {
  const uid = Number(userID);
  const now = new Date().toISOString();
  const next = reactions.filter((r) => Number(r.userID) !== uid);
  next.push({ userID: uid, emoji, reactedAt: now });
  return next;
};

const _removeUserReaction = (reactions, userID) => {
  const uid = Number(userID);
  return reactions.filter((r) => Number(r.userID) !== uid);
};

const _serializeReactionsColumn = (reactions) =>
  reactions.length > 0 ? JSON.stringify(reactions) : null;

/// Vérifie que [msgID] existe (non supprimé) et que [alanyaID] participe à la
/// conversation. Retourne conversationID ou null + code HTTP d'erreur.
const _messageReactionContext = async (msgID, alanyaID) => {
  const [existing] = await pool.execute(
    'SELECT conversationID FROM message WHERE msgID = ? AND isDeleted = 0',
    [msgID],
  );
  if (existing.length === 0) {
    return { error: { status: 404, body: { error: 'Message introuvable' } } };
  }
  const conversationID = existing[0].conversationID;

  const [member] = await pool.execute(
    'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
    [conversationID, alanyaID],
  );
  if (member.length === 0) {
    return { error: { status: 403, body: { error: 'Non autorisé' } } };
  }

  return { conversationID };
};

const _emitMessageReaction = (req, payload) => {
  const io = req.app.get('io');
  if (io) {
    io.to(`conversation_${payload.conversationID}`).emit('message:reaction', payload);
  }
};

/// Pose/remplace ma réaction sur un message. Diffuse `message:reaction`.
const setReaction = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const emoji = (req.body.emoji ?? '').toString().trim();
    if (!emoji) {
      return res.status(400).json({ error: 'emoji requis' });
    }

    const ctx = await _messageReactionContext(id, alanyaID);
    if (ctx.error) {
      return res.status(ctx.error.status).json(ctx.error.body);
    }
    const { conversationID } = ctx;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT reactions FROM message WHERE msgID = ? AND isDeleted = 0 FOR UPDATE',
        [id],
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Message introuvable' });
      }
      const reactions = _upsertUserReaction(_parseReactionsColumn(rows[0].reactions), alanyaID, emoji);
      await conn.execute(
        'UPDATE message SET reactions = ? WHERE msgID = ?',
        [_serializeReactionsColumn(reactions), id],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    const payload = {
      msgID: parseInt(id, 10),
      conversationID,
      userID: alanyaID,
      emoji,
    };

    _emitMessageReaction(req, payload);
    res.json(payload);
  } catch (error) {
    throw error;
  }
};

/// Retire ma réaction sur un message. Diffuse `message:reaction` sans emoji.
const removeReaction = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const ctx = await _messageReactionContext(id, alanyaID);
    if (ctx.error) {
      return res.status(ctx.error.status).json(ctx.error.body);
    }
    const { conversationID } = ctx;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT reactions FROM message WHERE msgID = ? AND isDeleted = 0 FOR UPDATE',
        [id],
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Message introuvable' });
      }
      const reactions = _removeUserReaction(_parseReactionsColumn(rows[0].reactions), alanyaID);
      await conn.execute(
        'UPDATE message SET reactions = ? WHERE msgID = ?',
        [_serializeReactionsColumn(reactions), id],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    const payload = {
      msgID: parseInt(id, 10),
      conversationID,
      userID: alanyaID,
    };

    _emitMessageReaction(req, payload);
    res.json(payload);
  } catch (error) {
    throw error;
  }
};

/// Hydratation initiale : toutes les réactions d'une conversation.
const getConversationReactions = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [id, alanyaID],
    );
    if (member.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // `has_reactions` (migration 059) est une colonne générée STORED et
    // indexée : remplace le filtre JSON_LENGTH(reactions) > 0, non sargable,
    // qui forçait un scan complet de l'historique à chaque ouverture d'écran
    // (audit scalabilité 06/08/2026 §5.1). LIMIT en dur comme plafond de
    // sécurité — cet endpoint reste, par conception, une hydratation
    // complète (pas de curseur, voir §3 du plan d'implémentation).
    const [rows] = await pool.execute(
      `SELECT msgID, reactions
       FROM message
       WHERE conversationID = ?
         AND isDeleted = 0
         AND has_reactions = 1
       LIMIT 5000`,
      [id],
    );

    const out = [];
    for (const row of rows) {
      for (const reaction of _parseReactionsColumn(row.reactions)) {
        const userID = Number(reaction.userID);
        const emoji = (reaction.emoji ?? '').toString();
        if (!userID || !emoji) continue;
        out.push({
          msgID: row.msgID,
          userID,
          emoji,
          reactedAt: reaction.reactedAt ?? null,
        });
      }
    }

    out.sort((a, b) => {
      const ta = a.reactedAt ? new Date(a.reactedAt).getTime() : 0;
      const tb = b.reactedAt ? new Date(b.reactedAt).getTime() : 0;
      return ta - tb;
    });

    res.json(out);
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
        `UPDATE message SET isDeleted = 1, deletedForID = NULL WHERE msgID IN (${placeholders}) AND isDeleted = 0`,
        ids,
      );
      for (const row of existing) {
        await conn.execute(
          'UPDATE conversation SET message_count = GREATEST(0, message_count - 1) WHERE conversID = ?',
          [row.conversationID],
        );
      }
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
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
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

    // Plafond défensif : la clause OR ci-dessous a une branche par curseur, donc
    // par conversation. Sans borne, un client avec beaucoup de conversations
    // construirait une requête de taille arbitraire à chaque sync (audit
    // scalabilité 06/08/2026 §3.3). 100 est très généreux au regard du volume
    // actuel par utilisateur ; ce log signale s'il faut un jour faire itérer
    // le client sur plusieurs appels plutôt que tout envoyer d'un coup.
    const MAX_SYNC_CURSORS = 100;
    let cursorEntries = [...cursorByConv.entries()];
    if (cursorEntries.length > MAX_SYNC_CURSORS) {
      console.warn(
        `[getMessagesSince] ${cursorEntries.length} curseurs reçus, plafonné à ${MAX_SYNC_CURSORS} (alanyaID=${alanyaID})`,
      );
      cursorEntries = cursorEntries.slice(0, MAX_SYNC_CURSORS);
    }

    // Clauses OR (conversationID = ? AND msgID > ?) — bornées par participation.
    const orClauses = [];
    const orParams = [];
    for (const [c, m] of cursorEntries) {
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
             (m.viewedAt IS NOT NULL) AS viewedByMe,
             TO_BASE64(mt.thumb) AS mediaThumb
      FROM message m
      JOIN conv_participants cp ON cp.conversID = m.conversationID AND cp.alanyaID = ?
      JOIN users u ON m.senderID = u.alanyaID
      LEFT JOIN pays p ON u.idPays = p.idPays
      LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
      WHERE m.isDeleted = 0
        AND (m.deletedForID IS NULL OR m.deletedForID != ?)
        AND ${HISTORY_CUTOFF_SQL}
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
// `next(error)` : même raison que `sendMessage`. C'est la requête que le client
// utilise pour savoir si une réponse rapide était déjà passée avant de la
// rejouer — elle ne doit surtout pas pouvoir tuer le process.
const getMessageStatusByClientId = async (req, res, next) => {
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
    next(error);
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

/**
 * Accusé de REMISE émis par la couche push (app fermée : le terminal a reçu la
 * notification mais n'a pas de socket). Équivalent HTTP de `message:delivered`,
 * idempotent, sans effet si les messages sont déjà remis ou déjà lus.
 */
// `next(error)` : appelé à CHAQUE push reçue par la couche native. Une base sans
// la migration 023 renvoie ER_BAD_FIELD_ERROR sur `deliveredAt` — avec `throw`,
// c'était un crash du process à chaque notification, en boucle.
const markMessagesDelivered = async (req, res, next) => {
  try {
    const alanyaID = req.user.alanyaID;
    const conversationID = Number(
      req.body?.conversationId ?? req.body?.conversationID,
    );
    if (!conversationID) {
      return res.status(400).json({ error: 'conversationId required' });
    }

    const [membership] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [conversationID, alanyaID],
    );
    if (membership.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const result = await markConversationDeliveredBy({
      conversationID,
      recipientID: alanyaID,
      io: req.app.get('io'),
    });

    res.json({ ok: true, changed: result.changed });
  } catch (error) {
    next(error);
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
  setReaction,
  removeReaction,
  getConversationReactions,
  getMessageStatusByClientId,
  getPendingOutgoingMessages,
  markMessagesDelivered,
};
