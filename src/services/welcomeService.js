const pool = require('../config/db');
const { getOfficialAccountId } = require('../utils/officialAccountGuard');
const { ensureDirectConversation } = require('./broadcastService');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { notifyNewMessage } = require('./notificationService');
const { enqueue } = require('./jobQueue');

const {
  normalizeLocale,
  pickLocalized,
} = require('../utils/localeContent');

const WELCOME_CTA_MSG_TYPE = 8;
const BACKFILL_BATCH = 100;

/** `statut.text` est un TINYTEXT : 255 octets, pas 255 caractères. */
const STATUS_TEXT_MAX = 200;

/** Durée de vie d'un statut, alignée sur `statutController.createStatus`. */
const STATUS_TTL_HOURS = 24;

function mapBlockRow(row) {
  let ctaJson = row.cta_json;
  if (typeof ctaJson === 'string') {
    try { ctaJson = JSON.parse(ctaJson); } catch (_) { ctaJson = null; }
  }
  return {
    id: row.id,
    sortOrder: row.sort_order,
    blockType: row.block_type,
    contentFr: row.content_fr ?? '',
    contentEn: row.content_en ?? '',
    mediaUrl: row.media_url ?? '',
    ctaJson,
  };
}

function mapConfigRow(row, blocks = []) {
  return {
    id: row.id,
    version: row.version,
    isActive: !!row.is_active,
    isDraft: !!row.is_draft,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    blocks,
  };
}

async function loadBlocksForConfig(configId, conn = pool) {
  const [rows] = await conn.execute(
    'SELECT * FROM welcome_block WHERE config_id = ? ORDER BY sort_order ASC, id ASC',
    [configId],
  );
  return rows.map(mapBlockRow);
}

async function getActiveConfig() {
  const [rows] = await pool.execute(
    'SELECT * FROM welcome_config WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
  );
  if (!rows.length) return null;
  const blocks = await loadBlocksForConfig(rows[0].id);
  return mapConfigRow(rows[0], blocks);
}

async function getDraftConfig(conn = pool) {
  const [rows] = await conn.execute(
    'SELECT * FROM welcome_config WHERE is_draft = 1 ORDER BY id DESC LIMIT 1',
  );
  if (!rows.length) return null;
  const blocks = await loadBlocksForConfig(rows[0].id, conn);
  return mapConfigRow(rows[0], blocks);
}

async function ensureDraftConfig(conn) {
  let draft = await getDraftConfig(conn);
  if (draft) return draft;

  const active = await getActiveConfig();
  const [ins] = await conn.execute(
    'INSERT INTO welcome_config (version, is_active, is_draft) VALUES (?, 0, 1)',
    [active?.version ?? 1],
  );
  const draftId = ins.insertId;

  if (active?.blocks?.length) {
    for (const b of active.blocks) {
      await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draftId,
          b.sortOrder,
          b.blockType,
          b.contentFr,
          b.contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
    }
  }

  const [rows] = await conn.execute('SELECT * FROM welcome_config WHERE id = ?', [draftId]);
  const blocks = await loadBlocksForConfig(draftId, conn);
  return mapConfigRow(rows[0], blocks);
}

async function getAdminWelcomeState() {
  const [active, draft] = await Promise.all([getActiveConfig(), getDraftConfig()]);
  return { active, draft: draft ?? active };
}

function blockToMessagePayload(block, locale, configId, alanyaID, sortOrder) {
  const clientId = `welcome:${configId}:${alanyaID}:${sortOrder}`;
  switch (block.blockType) {
    case 'text': {
      const content = pickLocalized(block, locale, 'content');
      return { type: 0, content, mediaUrl: null, clientId };
    }
    case 'image':
      return {
        type: 1,
        content: pickLocalized(block, locale, 'content') || null,
        mediaUrl: block.mediaUrl || null,
        clientId,
      };
    case 'video':
      return {
        type: 2,
        content: pickLocalized(block, locale, 'content') || null,
        mediaUrl: block.mediaUrl || null,
        clientId,
      };
    case 'cta': {
      const raw = block.ctaJson?.buttons ?? [];
      const buttons = raw.map((btn) => ({
        label: locale === 'en'
          ? (btn.labelEn || btn.labelFr || '')
          : (btn.labelFr || btn.labelEn || ''),
        action: btn.action === 'url' ? 'url' : 'route',
        target: String(btn.target || ''),
      })).filter((b) => b.label && b.target);
      return {
        type: WELCOME_CTA_MSG_TYPE,
        content: JSON.stringify({ buttons }),
        mediaUrl: null,
        clientId,
      };
    }
    default:
      return null;
  }
}

/* ── Statut de bienvenue ──────────────────────────────────────────────────
 *
 * Réglage global et non versionné : l'interrupteur agit sans passer par
 * « Publier », contrairement au message. Voir migrations/044_welcome_status.sql.
 */

function mapStatusConfigRow(row) {
  return {
    enabled: !!row.enabled,
    type: Number(row.type) || 0,
    textFr: row.text_fr ?? '',
    textEn: row.text_en ?? '',
    mediaUrl: row.media_url ?? '',
    backgroundColor: row.background_color ?? '',
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

async function getWelcomeStatusConfig() {
  const [[row]] = await pool.execute(
    'SELECT * FROM welcome_status_config WHERE id = 1',
  );
  if (!row) {
    return {
      enabled: false, type: 0, textFr: '', textEn: '',
      mediaUrl: '', backgroundColor: '', updatedAt: null, updatedBy: null,
    };
  }
  return mapStatusConfigRow(row);
}

/** Couleur de fond acceptée par l'app : `#RRGGBB` (cf. `_parseColor`). */
function normalizeBackgroundColor(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const hex = v.startsWith('#') ? v.slice(1) : v;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    const err = new Error('Couleur de fond invalide (#RRGGBB attendu)');
    err.status = 400;
    throw err;
  }
  return `#${hex.toUpperCase()}`;
}

function normalizeStatusText(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (v.length > STATUS_TEXT_MAX) {
    const err = new Error(`Texte du statut limité à ${STATUS_TEXT_MAX} caractères`);
    err.status = 400;
    throw err;
  }
  return v;
}

async function saveWelcomeStatusConfig(patch, adminId) {
  const type = [0, 1, 2].includes(Number(patch?.type)) ? Number(patch.type) : 0;
  const textFr = normalizeStatusText(patch?.textFr);
  const textEn = normalizeStatusText(patch?.textEn);
  const mediaUrl = patch?.mediaUrl ? String(patch.mediaUrl).slice(0, 512) : null;
  const backgroundColor = normalizeBackgroundColor(patch?.backgroundColor);
  const enabled = patch?.enabled ? 1 : 0;

  // Activer sans contenu livrable produirait des statuts vides : on refuse ici
  // plutôt que de laisser passer et d'échouer silencieusement à la livraison.
  if (enabled) {
    if (type === 0 && !textFr) {
      const err = new Error('Un statut texte exige un texte en français');
      err.status = 400;
      throw err;
    }
    if (type !== 0 && !mediaUrl) {
      const err = new Error('Un statut image ou vidéo exige un média');
      err.status = 400;
      throw err;
    }
  }

  await pool.execute(
    `INSERT INTO welcome_status_config
       (id, enabled, type, text_fr, text_en, media_url, background_color, updated_by)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled), type = VALUES(type),
       text_fr = VALUES(text_fr), text_en = VALUES(text_en),
       media_url = VALUES(media_url), background_color = VALUES(background_color),
       updated_by = VALUES(updated_by)`,
    [enabled, type, textFr || null, textEn || null, mediaUrl, backgroundColor, adminId ?? null],
  );

  return getWelcomeStatusConfig();
}

/**
 * Publie le statut de bienvenue pour un utilisateur.
 *
 * Volontairement indépendant du message : le statut part même si aucune version
 * du message n'est active, et une erreur ici ne doit jamais faire échouer la fin
 * d'onboarding. La ligne `welcome_status_delivery` sert à la fois de clé de
 * visibilité et de garde anti-doublon (`alanyaID` UNIQUE).
 */
async function deliverWelcomeStatus(alanyaID) {
  const config = await getWelcomeStatusConfig();
  if (!config.enabled) return { delivered: false, reason: 'DISABLED' };

  const hasContent = config.type === 0 ? !!config.textFr : !!config.mediaUrl;
  if (!hasContent) return { delivered: false, reason: 'EMPTY_STATUS' };

  const officialId = await getOfficialAccountId();
  if (!officialId) return { delivered: false, reason: 'NO_OFFICIAL_ACCOUNT' };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[dup]] = await conn.execute(
      'SELECT statut_id FROM welcome_status_delivery WHERE alanyaID = ? FOR UPDATE',
      [alanyaID],
    );
    if (dup) {
      await conn.commit();
      return { delivered: false, reason: 'ALREADY_DELIVERED', statutId: dup.statut_id };
    }

    const [ins] = await conn.execute(
      `INSERT INTO statut
         (alanyaID, type, text, text_en, mediaUrl, backgroundColor,
          createdAt, expiredAt, viewedBy, likedBy)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), 0, 0)`,
      [
        officialId,
        config.type,
        config.textFr || '',
        config.textEn || null,
        config.mediaUrl || null,
        config.backgroundColor || null,
        STATUS_TTL_HOURS,
      ],
    );

    await conn.execute(
      'INSERT INTO welcome_status_delivery (alanyaID, statut_id) VALUES (?, ?)',
      [alanyaID, ins.insertId],
    );

    await conn.commit();
    return { delivered: true, statutId: ins.insertId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Purge les statuts de bienvenue expirés.
 *
 * Sans elle, `statut` grossirait d'une ligne par inscription, indéfiniment :
 * l'app cesse de les afficher après 24 h mais rien ne les supprimait.
 * La suppression en cascade nettoie `welcome_status_delivery`.
 */
async function purgeExpiredWelcomeStatuses({ retentionDays = 7 } = {}) {
  const [res] = await pool.execute(
    `DELETE s FROM statut s
     JOIN welcome_status_delivery w ON w.statut_id = s.ID
     WHERE s.expiredAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [retentionDays],
  );
  return { purged: res.affectedRows || 0 };
}

async function deliverWelcome(alanyaID, { locale = 'fr' } = {}) {
  const loc = normalizeLocale(locale);

  // Le statut ne dépend pas du message : on le tente d'abord, et son échec
  // éventuel ne doit pas interrompre la fin d'onboarding.
  let welcomeStatus = { delivered: false, reason: 'ERROR' };
  try {
    welcomeStatus = await deliverWelcomeStatus(alanyaID);
  } catch (e) {
    console.error('[welcome] échec du statut de bienvenue:', e.message);
  }

  const [[delivery]] = await pool.execute(
    'SELECT conversID, config_id FROM welcome_delivery WHERE alanyaID = ?',
    [alanyaID],
  );

  if (delivery) {
    const officialId = await getOfficialAccountId();
    let officialName = 'Alanya';
    let officialAvatar = '';
    if (officialId) {
      const [[u]] = await pool.execute(
        'SELECT nom, avatarUrl FROM users WHERE alanyaID = ?',
        [officialId],
      );
      officialName = u?.nom || officialName;
      officialAvatar = u?.avatarUrl || '';
    }
    return {
      delivered: false,
      alreadyDelivered: true,
      conversationId: delivery.conversID,
      configId: delivery.config_id,
      senderId: officialId,
      senderName: officialName,
      senderAvatar: officialAvatar,
      messageCount: 0,
      statusDelivered: welcomeStatus.delivered,
    };
  }

  const config = await getActiveConfig();
  if (!config?.blocks?.length) {
    return {
      delivered: false, skipped: true, reason: 'NO_ACTIVE_CONFIG',
      statusDelivered: welcomeStatus.delivered,
    };
  }

  const officialId = await getOfficialAccountId();
  if (!officialId) {
    return {
      delivered: false, skipped: true, reason: 'NO_OFFICIAL_ACCOUNT',
      statusDelivered: welcomeStatus.delivered,
    };
  }

  const [[officialUser]] = await pool.execute(
    'SELECT nom, avatarUrl FROM users WHERE alanyaID = ?',
    [officialId],
  );

  const conn = await pool.getConnection();
  let conversID;
  let messageCount = 0;
  let lastPreview = '';
  let lastType = 0;

  try {
    await conn.beginTransaction();

    const [[dup]] = await conn.execute(
      'SELECT conversID, config_id FROM welcome_delivery WHERE alanyaID = ? FOR UPDATE',
      [alanyaID],
    );
    if (dup) {
      await conn.commit();
      return {
        delivered: false,
        alreadyDelivered: true,
        conversationId: dup.conversID,
        configId: dup.config_id,
        senderId: officialId,
        senderName: officialUser?.nom || 'Alanya',
        senderAvatar: officialUser?.avatarUrl || '',
        messageCount: 0,
        statusDelivered: welcomeStatus.delivered,
      };
    }

    conversID = await ensureDirectConversation(conn, officialId, alanyaID);
    const sentAt = new Date();

    for (const block of config.blocks) {
      const payload = blockToMessagePayload(block, loc, config.id, alanyaID, block.sortOrder);
      if (!payload || (payload.type !== 0 && !payload.content && !payload.mediaUrl)) continue;

      await conn.execute(
        `INSERT INTO message
          (senderID, conversationID, content, type, status, sendAt, clientID, mediaUrl)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE msgID = msgID`,
        [
          officialId,
          conversID,
          payload.content,
          payload.type,
          sentAt,
          payload.clientId,
          payload.mediaUrl,
        ],
      );
      messageCount += 1;
      lastPreview = resolveLastMessagePreview({
        content: payload.content,
        type: payload.type,
      });
      lastType = payload.type;
    }

    if (messageCount === 0) {
      await conn.rollback();
      return {
        delivered: false, skipped: true, reason: 'EMPTY_CONFIG',
        statusDelivered: welcomeStatus.delivered,
      };
    }

    await conn.execute(
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = ?, lastMessageSenderID = ?,
           lastMessageType = ?, lastMessageStatus = 1,
           message_count = message_count + ?
       WHERE conversID = ?`,
      [lastPreview, sentAt, officialId, lastType, messageCount, conversID],
    );

    await conn.execute(
      'UPDATE conv_participants SET unreadCount = unreadCount + ? WHERE conversID = ? AND alanyaID = ?',
      [messageCount, conversID, alanyaID],
    );

    await conn.execute(
      'INSERT INTO welcome_delivery (alanyaID, config_id, conversID) VALUES (?, ?, ?)',
      [alanyaID, config.id, conversID],
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const lastBody = lastPreview || 'Message de bienvenue';
  await notifyNewMessage(conversID, officialId, officialUser?.nom || 'Alanya', {
    content: lastBody,
    type: lastType,
    msgID: 0,
    clientId: `welcome:${config.id}:${alanyaID}:tail`,
    senderAvatar: officialUser?.avatarUrl || '',
    unreadTotal: messageCount,
  });

  return {
    delivered: true,
    alreadyDelivered: false,
    conversationId: conversID,
    configId: config.id,
    senderId: officialId,
    senderName: officialUser?.nom || 'Alanya',
    senderAvatar: officialUser?.avatarUrl || '',
    messageCount,
    statusDelivered: welcomeStatus.delivered,
  };
}

async function saveDraft(blocks, adminId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const draft = await ensureDraftConfig(conn);

    await conn.execute('DELETE FROM welcome_block WHERE config_id = ?', [draft.id]);

    const sorted = [...(blocks || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (let i = 0; i < sorted.length; i += 1) {
      const b = sorted[i];
      await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draft.id,
          b.sortOrder ?? i,
          b.blockType,
          b.contentFr ?? '',
          b.contentEn ?? '',
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
    }

    await conn.execute('UPDATE welcome_config SET updated_at = NOW() WHERE id = ?', [draft.id]);
    await conn.commit();

    return getDraftConfig();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function publishDraft(adminId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const draft = await ensureDraftConfig(conn);
    const blocks = await loadBlocksForConfig(draft.id, conn);
    if (!blocks.length) {
      const err = new Error('Le brouillon est vide');
      err.status = 400;
      throw err;
    }

    const [[maxRow]] = await conn.execute(
      'SELECT COALESCE(MAX(version), 0) AS m FROM welcome_config WHERE is_draft = 0',
    );
    const nextVersion = Number(maxRow.m) + 1;

    await conn.execute('UPDATE welcome_config SET is_active = 0 WHERE is_active = 1');

    const [ins] = await conn.execute(
      `INSERT INTO welcome_config (version, is_active, is_draft, published_at, published_by)
       VALUES (?, 1, 0, NOW(), ?)`,
      [nextVersion, adminId],
    );
    const newId = ins.insertId;

    for (const b of blocks) {
      await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId,
          b.sortOrder,
          b.blockType,
          b.contentFr,
          b.contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
    }

    // Resync draft from published
    await conn.execute('DELETE FROM welcome_block WHERE config_id = ?', [draft.id]);
    const publishedBlocks = await loadBlocksForConfig(newId, conn);
    for (const b of publishedBlocks) {
      await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draft.id,
          b.sortOrder,
          b.blockType,
          b.contentFr,
          b.contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
    }
    await conn.execute(
      'UPDATE welcome_config SET version = ? WHERE id = ?',
      [nextVersion, draft.id],
    );

    await conn.commit();
    return getActiveConfig();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function countBackfillCandidates() {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM users u
     WHERE u.exclus = 0 AND u.account_type != 2
       AND NOT EXISTS (SELECT 1 FROM welcome_delivery wd WHERE wd.alanyaID = u.alanyaID)`,
  );
  return Number(row.c) || 0;
}

async function processWelcomeBackfillBatch({ idFrom = 0, limit = BACKFILL_BATCH } = {}) {
  const config = await getActiveConfig();
  if (!config) return { processed: 0, delivered: 0 };

  const [users] = await pool.execute(
    `SELECT u.alanyaID FROM users u
     WHERE u.exclus = 0 AND u.account_type != 2
       AND u.alanyaID > ?
       AND NOT EXISTS (SELECT 1 FROM welcome_delivery wd WHERE wd.alanyaID = u.alanyaID)
     ORDER BY u.alanyaID ASC
     LIMIT ${Number(limit) || BACKFILL_BATCH}`,
    [idFrom],
  );

  let delivered = 0;
  let lastId = idFrom;
  for (const u of users) {
    lastId = Number(u.alanyaID);
    try {
      const r = await deliverWelcome(lastId, { locale: 'fr' });
      if (r.delivered) delivered += 1;
    } catch (e) {
      console.warn('[Welcome] backfill user', lastId, e.message);
    }
  }

  return {
    processed: users.length,
    delivered,
    lastId,
    hasMore: users.length >= limit,
  };
}

async function startBackfill(adminId) {
  void adminId;
  const pending = await countBackfillCandidates();
  if (!pending) return { queued: false, pending: 0 };

  await enqueue(
    'welcome_backfill',
    { idFrom: 0 },
    { dedupeKey: 'welcome_backfill' },
  );

  return { queued: true, pending };
}

async function continueBackfillChain(lastId, hasMore) {
  if (!hasMore) return;
  await enqueue(
    'welcome_backfill',
    { idFrom: lastId },
    { dedupeKey: `welcome_backfill:${lastId}` },
  );
}

module.exports = {
  WELCOME_CTA_MSG_TYPE,
  getAdminWelcomeState,
  saveDraft,
  publishDraft,
  deliverWelcome,
  countBackfillCandidates,
  processWelcomeBackfillBatch,
  startBackfill,
  continueBackfillChain,
  // Statut de bienvenue (réglage global, non versionné)
  STATUS_TEXT_MAX,
  getWelcomeStatusConfig,
  saveWelcomeStatusConfig,
  deliverWelcomeStatus,
  purgeExpiredWelcomeStatuses,
};
