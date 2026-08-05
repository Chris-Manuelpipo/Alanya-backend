const crypto = require('crypto');
const admin = require('../config/firebase');
const pool = require('../config/db');
const { buildDirectConversationLookup } = require('../utils/directConversation');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const {
  resolveRelativeDates,
  compileToSql,
  evaluateInMemory,
  countAudience,
} = require('./criteriaResolver');
const { generateEventId, stringifyData } = require('../notifications/notificationContract');
const { enqueue } = require('./jobQueue');

const PUSH_BATCH = 500;
const USER_PAGE = 1000;
const CACHE_REFRESH_MS = 30_000;

let maxBroadcastId = null;
let cacheTimer = null;

async function initBroadcastCache() {
  try {
    const [[row]] = await pool.execute('SELECT COALESCE(MAX(id), 0) AS m FROM broadcast');
    maxBroadcastId = Number(row.m);
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    maxBroadcastId = 0;
  }
  if (cacheTimer) clearInterval(cacheTimer);
  cacheTimer = setInterval(() => {
    initBroadcastCache().catch(() => {});
  }, CACHE_REFRESH_MS);
}

async function findBroadcastByClientId(clientId) {
  const [rows] = await pool.execute(
    'SELECT id, status FROM broadcast WHERE client_id = ? LIMIT 1',
    [clientId],
  );
  return rows[0] || null;
}

async function estimateAudience(criteria, sentAt = new Date()) {
  return countAudience(pool, criteria, sentAt);
}

async function publishBroadcast({
  senderId,
  createdBy,
  kind = 0,
  content,
  type = 0,
  mediaUrl = null,
  criteria,
  clientId,
  estimate = 0,
  scheduledAt = null,
}) {
  if (scheduledAt) {
    const runAfter = new Date(scheduledAt);
    await enqueue(
      'broadcast_send',
      {
        senderId,
        createdBy,
        kind,
        content,
        type,
        mediaUrl,
        criteria,
        clientId,
        estimate,
      },
      { dedupeKey: `broadcast_send:${clientId}`, runAfter },
    );
    return { scheduled: true, clientId, scheduledAt: runAfter.toISOString(), estimate };
  }

  const conn = await pool.getConnection();
  try {
    const [[lock]] = await conn.execute("SELECT GET_LOCK('broadcast_publish', 10) AS l");
    if (!lock.l) throw new Error('Publication diffusion occupée');

    const existing = await findBroadcastByClientId(clientId);
    if (existing) {
      await conn.execute("SELECT RELEASE_LOCK('broadcast_publish')");
      return { id: existing.id, status: existing.status, duplicate: true };
    }

    const sentAt = new Date();
    const resolvedCriteria = resolveRelativeDates(criteria, sentAt);
    const { count } = await countAudience(pool, resolvedCriteria, sentAt);

    await conn.beginTransaction();
    const [ins] = await conn.execute(
      `INSERT INTO broadcast
        (sender_id, created_by, kind, content, type, media_url, criteria, estimate,
         client_id, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`,
      [
        senderId,
        createdBy,
        kind,
        content,
        type,
        mediaUrl,
        JSON.stringify(resolvedCriteria),
        estimate || count,
        clientId,
        sentAt,
      ],
    );
    const broadcastId = ins.insertId;

    let statutId = null;
    if (kind === 1) {
      const expiredAt = new Date(sentAt.getTime() + 24 * 3600 * 1000);
      // La colonne du texte s'appelle `text`, pas `content` (migration 001).
      // Même gabarit que statutController.createStatus.
      const [st] = await conn.execute(
        `INSERT INTO statut (alanyaID, type, text, mediaUrl, createdAt, expiredAt,
                             viewedBy, likedBy)
         VALUES (?, ?, ?, ?, NOW(), ?, 0, 0)`,
        [senderId, type, content ?? '', mediaUrl, expiredAt],
      );
      statutId = st.insertId;
      await conn.execute('UPDATE broadcast SET statut_id = ? WHERE id = ?', [statutId, broadcastId]);
    }

    await conn.commit();
    await conn.execute("SELECT RELEASE_LOCK('broadcast_publish')");

    await enqueue(
      'broadcast_prepare',
      { broadcastId },
      { dedupeKey: `broadcast_prepare:${broadcastId}` },
    );

    if (broadcastId > (maxBroadcastId || 0)) maxBroadcastId = broadcastId;
    return { id: broadcastId, status: 'preparing', estimate: estimate || count, statutId };
  } catch (e) {
    try { await conn.execute("SELECT RELEASE_LOCK('broadcast_publish')"); } catch (_) {}
    if (conn) await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function prepareBroadcast(broadcastId) {
  const [rows] = await pool.execute('SELECT * FROM broadcast WHERE id = ?', [broadcastId]);
  if (!rows.length) return;
  const b = rows[0];
  if (b.status !== 'preparing') return;

  const criteria = typeof b.criteria === 'string' ? JSON.parse(b.criteria) : b.criteria;
  const sentAt = b.sent_at;
  const { whereFragment, params } = compileToSql(criteria, { sentAt });

  let lastId = 0;
  let totalJobs = 0;

  while (true) {
    // LIMIT en littéral : mysql2 / certaines versions MySQL refusent LIMIT ?
    // en requête préparée (« Incorrect arguments to mysqld_stmt_execute »).
    const [users] = await pool.execute(
      `SELECT alanyaID FROM users u
       WHERE ${whereFragment} AND u.alanyaID > ?
       ORDER BY u.alanyaID ASC
       LIMIT ${USER_PAGE}`,
      [...params, lastId],
    );
    if (!users.length) break;

    const fromId = users[0].alanyaID;
    const toId = users[users.length - 1].alanyaID;
    await enqueue(
      'broadcast_push',
      { broadcastId, idFrom: fromId, idTo: toId },
      { dedupeKey: `broadcast_push:${broadcastId}:${fromId}:${toId}` },
    );
    totalJobs += 1;
    lastId = toId;
    if (users.length < USER_PAGE) break;
  }

  await pool.execute(
    `UPDATE broadcast SET push_jobs_total = ?, status = 'queued' WHERE id = ? AND status = 'preparing'`,
    [totalJobs, broadcastId],
  );
}

/**
 * Comptes du lot ayant coupé les annonces. Une seule requête : l'absence de
 * ligne vaut « activé » (DEFAULT_PREFS.broadcastsEnabled = 1), on ne remonte
 * donc que les refus explicites.
 *
 * @param {number[]} ids
 * @returns {Promise<Set<number>>}
 */
async function loadBroadcastOptOut(ids) {
  const optedOut = new Set();
  if (!ids.length) return optedOut;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const [rows] = await pool.execute(
      `SELECT alanyaID FROM user_notification_prefs
       WHERE alanyaID IN (${placeholders}) AND broadcastsEnabled = 0`,
      ids,
    );
    for (const r of rows) optedOut.add(Number(r.alanyaID));
  } catch (e) {
    // Table ou colonne absente avant migration : personne n'a coupé.
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  return optedOut;
}

/**
 * Jetons FCM du lot depuis le registre multi-appareils, en une requête.
 * Les comptes sans appareil enregistré sont absents de la Map : l'appelant
 * bascule alors sur `users.fcm_token`.
 *
 * @param {number[]} ids
 * @returns {Promise<Map<number, string[]>>}
 */
async function loadPushTokensForBatch(ids) {
  const byUser = new Map();
  if (!ids.length) return byUser;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const [devices] = await pool.execute(
      `SELECT alanyaID, fcmToken FROM user_push_devices
       WHERE alanyaID IN (${placeholders})
         AND notificationsEnabled = 1
         AND fcmToken IS NOT NULL AND fcmToken <> 'INDEFINI'`,
      ids,
    );
    for (const d of devices) {
      const id = Number(d.alanyaID);
      if (!byUser.has(id)) byUser.set(id, []);
      byUser.get(id).push(d.fcmToken);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  return byUser;
}

/**
 * Jetons à notifier pour un lot. Fonction pure : aucun accès base, donc
 * testable sans MySQL.
 *
 * Le registre multi-appareils prime — `users.fcm_token` ne porte qu'un seul
 * terminal et vaut souvent INDEFINI. Repli historique quand le compte n'a
 * aucun appareil enregistré, comme pushDeviceRegistry.loadLegacyToken.
 *
 * @param {Array<{alanyaID:number, fcm_token:string|null}>} users
 * @param {Set<number>} optedOut
 * @param {Map<number, string[]>} devicesByUser
 * @returns {string[]} jetons dédoublonnés
 */
function selectPushTokens(users, optedOut, devicesByUser) {
  const tokens = [];
  const seen = new Set();
  for (const u of users) {
    const id = Number(u.alanyaID);
    if (optedOut.has(id)) continue;

    const registered = devicesByUser.get(id);
    const userTokens = registered && registered.length
      ? registered
      : (u.fcm_token && u.fcm_token !== 'INDEFINI' ? [u.fcm_token] : []);

    for (const tok of userTokens) {
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      tokens.push(tok);
    }
  }
  return tokens;
}

async function sendBroadcastPushBatch({ broadcastId, idFrom, idTo }) {
  const [bRows] = await pool.execute('SELECT * FROM broadcast WHERE id = ?', [broadcastId]);
  if (!bRows.length) return;
  const b = bRows[0];
  if (!['queued', 'running', 'partial_failed'].includes(b.status) && b.status !== 'completed') return;

  const criteria = typeof b.criteria === 'string' ? JSON.parse(b.criteria) : b.criteria;
  const { whereFragment, params } = compileToSql(criteria, { sentAt: b.sent_at });

  const [users] = await pool.execute(
    `SELECT u.alanyaID, u.fcm_token FROM users u
     WHERE ${whereFragment}
       AND u.alanyaID >= ? AND u.alanyaID <= ?
       AND u.exclus = 0`,
    [...params, idFrom, idTo],
  );

  if (!users.length) {
    await markPushJobDone(broadcastId);
    return;
  }

  // Deux requêtes pour tout le lot, et non deux par destinataire : c'est
  // exactement le motif séquentiel qu'on a écarté de notifyNewMessage.
  const ids = users.map((u) => Number(u.alanyaID));
  const [optedOut, devicesByUser] = await Promise.all([
    loadBroadcastOptOut(ids),
    loadPushTokensForBatch(ids),
  ]);

  const tokens = selectPushTokens(users, optedOut, devicesByUser);

  if (tokens.length && admin.apps.length) {
    for (let i = 0; i < tokens.length; i += PUSH_BATCH) {
      const slice = tokens.slice(i, i + PUSH_BATCH);
      const data = stringifyData({
        schemaVersion: '2',
        eventId: generateEventId(),
        type: 'broadcast',
        broadcastId: String(broadcastId),
        senderId: String(b.sender_id),
        title: 'Alanya',
        body: b.content ? String(b.content).slice(0, 120) : (Number(b.kind) === 1 ? 'Nouveau statut' : 'Nouvelle annonce'),
      });
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: slice,
          data,
          android: { priority: 'high' },
          apns: { payload: { aps: { 'content-available': 1 } } },
        });
      } catch (e) {
        console.warn('[Broadcast] push batch:', e.message);
      }
    }
  }

  await markPushJobDone(broadcastId);
}

async function markPushJobDone(broadcastId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE broadcast SET push_jobs_done = push_jobs_done + 1,
        status = CASE WHEN status = 'queued' THEN 'running' ELSE status END
       WHERE id = ?`,
      [broadcastId],
    );
    const [[row]] = await conn.execute(
      'SELECT push_jobs_total, push_jobs_done, push_failed_jobs, status FROM broadcast WHERE id = ? FOR UPDATE',
      [broadcastId],
    );
    const terminal = row.push_jobs_done + row.push_failed_jobs >= row.push_jobs_total && row.push_jobs_total > 0;
    if (terminal) {
      const newStatus = row.push_failed_jobs > 0 ? 'partial_failed' : 'completed';
      await conn.execute(
        `UPDATE broadcast SET status = ?, push_completed_at = NOW() WHERE id = ?`,
        [newStatus, broadcastId],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function markPushJobFailed(broadcastId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE broadcast SET push_failed_jobs = push_failed_jobs + 1,
        status = CASE WHEN status = 'queued' THEN 'running' ELSE status END
       WHERE id = ?`,
      [broadcastId],
    );
    const [[row]] = await conn.execute(
      'SELECT push_jobs_total, push_jobs_done, push_failed_jobs FROM broadcast WHERE id = ? FOR UPDATE',
      [broadcastId],
    );
    if (row.push_jobs_done + row.push_failed_jobs >= row.push_jobs_total && row.push_jobs_total > 0) {
      const newStatus = row.push_failed_jobs > 0 ? 'partial_failed' : 'completed';
      await conn.execute(
        `UPDATE broadcast SET status = ?, push_completed_at = NOW() WHERE id = ?`,
        [newStatus, broadcastId],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function materializeForUser(alanyaID) {
  // Chemin chaud : `GET /api/conversations` est appelé à chaque ouverture de
  // l'application. Tant que le filigrane a rattrapé la dernière diffusion
  // connue — la quasi-totalité des appels — on sort sans transaction et sans
  // verrou. Le `FOR UPDATE` plus bas pose un verrou exclusif sur la ligne
  // `users`, qui entrerait sinon en contention avec les écritures de présence
  // (`is_online` / `last_seen`) à chaque ouverture.
  if (!maxBroadcastId) return;

  let watermark;
  try {
    const [[head]] = await pool.execute(
      'SELECT last_broadcast_id FROM users WHERE alanyaID = ?',
      [alanyaID],
    );
    if (!head) return;
    watermark = Number(head.last_broadcast_id) || 0;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return;
    throw e;
  }
  if (watermark >= maxBroadcastId) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[userRow]] = await conn.execute(
      `SELECT alanyaID, idPays, idVille, genre, age, account_type, verification_status,
              created_at, last_seen, verified_until, last_broadcast_id
       FROM users WHERE alanyaID = ? FOR UPDATE`,
      [alanyaID],
    );
    if (!userRow) {
      await conn.commit();
      return;
    }

    // Relu sous verrou : une requête concurrente a pu matérialiser entre-temps.
    let lastId = Number(userRow.last_broadcast_id) || 0;
    const maxId = maxBroadcastId ?? lastId;

    const [pending] = await conn.execute(
      `SELECT * FROM broadcast
       WHERE id > ? AND id <= ? AND status IN ('queued','running','completed','partial_failed')
       ORDER BY id ASC
       LIMIT 50`,
      [lastId, maxId],
    );

    for (const b of pending) {
      const criteria = typeof b.criteria === 'string' ? JSON.parse(b.criteria) : b.criteria;
      const match = evaluateInMemory(userRow, criteria, { sentAt: b.sent_at });
      if (match) {
        // kind=1 : statut déjà inséré à la publication (broadcast.statut_id).
        // Ne pas créer de message privé — il apparaît dans la bande Statuts.
        if (Number(b.kind) !== 1) {
          const [del] = await conn.execute(
            `INSERT IGNORE INTO broadcast_delivery (broadcast_id, alanyaID)
             VALUES (?, ?)`,
            [b.id, alanyaID],
          );
          if (del.affectedRows === 1) {
            const conversID = await ensureDirectConversation(conn, b.sender_id, alanyaID);
            const clientMsgId = `broadcast:${b.id}:${alanyaID}`;
            const [msgIns] = await conn.execute(
              `INSERT INTO message
                (senderID, conversationID, content, type, status, sendAt, clientID, mediaUrl)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
              [
                b.sender_id,
                conversID,
                b.content,
                b.type,
                b.sent_at,
                clientMsgId,
                b.media_url,
              ],
            );
            const msgID = msgIns.insertId;
            await conn.execute(
              `UPDATE conversation
               SET lastMessage = ?, lastMessageAt = ?, lastMessageSenderID = ?,
                   lastMessageType = ?, lastMessageStatus = 1, message_count = message_count + 1
               WHERE conversID = ?`,
              [
                resolveLastMessagePreview({ content: b.content, type: b.type }),
                b.sent_at,
                b.sender_id,
                b.type,
                conversID,
              ],
            );
            await conn.execute(
              'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID = ?',
              [conversID, alanyaID],
            );
            await conn.execute(
              `UPDATE broadcast_delivery SET conversID = ?, msgID = ?, delivered_at = NOW()
               WHERE broadcast_id = ? AND alanyaID = ?`,
              [conversID, msgID, b.id, alanyaID],
            );
          }
        }
      }
      lastId = b.id;
    }

    if (lastId > Number(userRow.last_broadcast_id)) {
      await conn.execute('UPDATE users SET last_broadcast_id = ? WHERE alanyaID = ?', [lastId, alanyaID]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  } finally {
    conn.release();
  }
}

async function ensureDirectConversation(conn, senderId, recipientId) {
  const lookup = buildDirectConversationLookup({ meId: recipientId, peerId: senderId });
  const [existing] = await conn.execute(lookup.sql, lookup.params);
  if (existing.length) return existing[0].conversID;

  const [result] = await conn.execute(
    'INSERT INTO conversation (isGroup, lastMessageAt) VALUES (0, NOW())',
  );
  const conversID = result.insertId;
  await conn.execute(
    'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?)',
    [conversID, recipientId, conversID, senderId],
  );
  return conversID;
}

async function runNightlyDeliveryMaintenance() {
  const [rows] = await pool.execute(
    `SELECT b.id, b.estimate,
            (SELECT COUNT(*) FROM broadcast_delivery d WHERE d.broadcast_id = b.id AND d.delivered_at IS NOT NULL) AS delivered
     FROM broadcast b
     WHERE b.status IN ('completed','partial_failed')`,
  );
  for (const r of rows) {
    await pool.execute(
      `UPDATE broadcast SET delivered_count = ?, delivered_count_refreshed_at = NOW() WHERE id = ?`,
      [Number(r.delivered), r.id],
    );
  }
  await pool.execute(
    `DELETE FROM broadcast_delivery
     WHERE delivered_at IS NOT NULL
       AND delivered_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`,
  );
}

function mapBroadcastRow(row) {
  const criteria = typeof row.criteria === 'string' ? JSON.parse(row.criteria) : row.criteria;
  const total = Number(row.push_jobs_total) || 0;
  const done = Number(row.push_jobs_done) + Number(row.push_failed_jobs);
  const pushProgress = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    id: row.id,
    senderId: row.sender_id,
    createdBy: row.created_by,
    kind: row.kind,
    content: row.content,
    type: row.type,
    mediaUrl: row.media_url,
    criteria,
    estimate: row.estimate,
    clientId: row.client_id,
    status: row.status,
    pushJobsTotal: total,
    pushJobsDone: Number(row.push_jobs_done),
    pushFailedJobs: Number(row.push_failed_jobs),
    pushProgress,
    pushStatus: row.status,
    pushCompletedAt: row.push_completed_at,
    deliveredCount: Number(row.delivered_count),
    deliveredCountRefreshedAt: row.delivered_count_refreshed_at,
    statutId: row.statut_id,
    sentAt: row.sent_at,
    senderName: row.sender_nom || null,
    openRate: row.estimate > 0 ? Number(row.delivered_count) / row.estimate : 0,
  };
}

module.exports = {
  initBroadcastCache,
  findBroadcastByClientId,
  estimateAudience,
  publishBroadcast,
  prepareBroadcast,
  sendBroadcastPushBatch,
  materializeForUser,
  markPushJobDone,
  markPushJobFailed,
  runNightlyDeliveryMaintenance,
  mapBroadcastRow,
  loadBroadcastOptOut,
  loadPushTokensForBatch,
  selectPushTokens,
};
