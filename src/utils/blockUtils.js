const pool = require('../config/db');
const { isSelfChatRow } = require('./directConversation');

/** true si blockerId a bloqué targetId */
const isBlockedBy = async (blockerId, targetId) => {
  const [rows] = await pool.execute(
    'SELECT 1 FROM blocked WHERE alanyaID = ? AND idCallerBlock = ? LIMIT 1',
    [blockerId, targetId],
  );
  return rows.length > 0;
};

/** true si un blocage existe dans un sens ou l'autre */
const isBlockedEitherWay = async (a, b) => {
  const [rows] = await pool.execute(
    `SELECT 1 FROM blocked
     WHERE (alanyaID = ? AND idCallerBlock = ?)
        OR (alanyaID = ? AND idCallerBlock = ?)
     LIMIT 1`,
    [a, b, b, a],
  );
  return rows.length > 0;
};

/** Statut bidirectionnel vu depuis viewerId vers otherId */
const getBlockPair = async (viewerId, otherId) => {
  const [rows] = await pool.execute(
    `SELECT alanyaID, idCallerBlock FROM blocked
     WHERE (alanyaID = ? AND idCallerBlock = ?)
        OR (alanyaID = ? AND idCallerBlock = ?)`,
    [viewerId, otherId, otherId, viewerId],
  );
  let iBlockedThem = false;
  let theyBlockedMe = false;
  for (const r of rows) {
    if (Number(r.alanyaID) === Number(viewerId) && Number(r.idCallerBlock) === Number(otherId)) {
      iBlockedThem = true;
    }
    if (Number(r.alanyaID) === Number(otherId) && Number(r.idCallerBlock) === Number(viewerId)) {
      theyBlockedMe = true;
    }
  }
  return { isBlocked: iBlockedThem, blockedByThem: theyBlockedMe, iBlockedThem, theyBlockedMe };
};

const getBlockDate = async (blockerId, targetId) => {
  const [rows] = await pool.execute(
    'SELECT dateBlock FROM blocked WHERE alanyaID = ? AND idCallerBlock = ? LIMIT 1',
    [blockerId, targetId],
  );
  return rows.length ? rows[0].dateBlock : null;
};

/**
 * Autre participant d'une conv. 1-1, ou null si groupe / self-chat / introuvable.
 *
 * Une conversation avec soi-même n'a pas de pair : elle est donc traitée comme
 * « non directe » et échappe à toute la politique de blocage, ce qui est le
 * comportement voulu (on ne se bloque pas soi-même).
 */
const getDirectConversationPeer = async (conversationID, userId) => {
  const [rows] = await pool.execute(
    `SELECT c.isGroup, c.GroupName,
            (SELECT COUNT(*) FROM conv_participants p
             WHERE p.conversID = c.conversID AND p.alanyaID != ?) AS peerCount,
            (SELECT p.alanyaID FROM conv_participants p
             WHERE p.conversID = c.conversID AND p.alanyaID != ?
             LIMIT 1) AS peerId
     FROM conversation c
     WHERE c.conversID = ?
     LIMIT 1`,
    [userId, userId, conversationID],
  );
  if (!rows.length || rows[0].isGroup) return null;
  if (isSelfChatRow(rows[0])) return null;
  if (Number(rows[0].peerCount) !== 1) return null;
  const peerId = rows[0].peerId;
  return peerId != null ? Number(peerId) : null;
};

/**
 * Cache court (TTL 60 s) au-dessus de getDirectConversationPeer, pour les
 * chemins d'accusés de réception qui l'appellent à chaque message reçu.
 */
const _peerCache = new Map();
const PEER_TTL_MS = 60_000;

const getCachedDirectConversationPeer = async (conversationID, userId) => {
  const key = `${conversationID}:${userId}`;
  const hit = _peerCache.get(key);
  if (hit && Date.now() - hit.at < PEER_TTL_MS) return hit.peerId;
  const peerId = await getDirectConversationPeer(conversationID, userId);
  _peerCache.set(key, { at: Date.now(), peerId });
  if (_peerCache.size > 500) {
    _peerCache.delete(_peerCache.keys().next().value);
  }
  return peerId;
};

/**
 * Évalue les règles de blocage pour un envoi 1-1.
 * action: 'deliver' | 'reject' | 'silent'
 *
 * Fast path : 1 requête (type conv + peer) + 1 requête blocage (au lieu de 3).
 */
const evaluateDirectMessageSend = async (conversationID, senderID) => {
  const peerId = await getDirectConversationPeer(conversationID, senderID);
  if (peerId == null) return { isDirect: false };

  const pair = await getBlockPair(senderID, peerId);
  if (pair.iBlockedThem) {
    return { isDirect: true, peerId, action: 'reject', code: 'BLOCKED_BY_SENDER', ...pair };
  }
  if (pair.theyBlockedMe) {
    return { isDirect: true, peerId, action: 'silent', ...pair };
  }
  return { isDirect: true, peerId, action: 'deliver', ...pair };
};

/** Bloque la propagation typing/delivery entre deux utilisateurs bloqués en 1-1 */
const shouldSuppressDirectInteraction = async (conversationID, fromUserId, toUserId) => {
  const peerId = await getDirectConversationPeer(conversationID, fromUserId);
  if (peerId == null || Number(peerId) !== Number(toUserId)) return false;
  return isBlockedEitherWay(fromUserId, toUserId);
};

/** Masque is_online / last_seen si subjectId a bloqué viewerId */
const maskPresenceIfBlocked = async (viewerId, subjectId, isOnline, lastSeen) => {
  if (viewerId == null || Number(viewerId) === Number(subjectId)) {
    return { is_online: isOnline, last_seen: lastSeen };
  }
  if (await isBlockedBy(subjectId, viewerId)) {
    return { is_online: 0, last_seen: null };
  }
  return { is_online: isOnline, last_seen: lastSeen };
};

/** Ne pas notifier la présence aux utilisateurs bloqués par subjectUserId */
const emitPresenceUpdate = async (io, subjectUserId, payload) => {
  const [blocked] = await pool.execute(
    'SELECT idCallerBlock FROM blocked WHERE alanyaID = ?',
    [subjectUserId],
  );
  const exceptRooms = blocked.map((r) => `user_${r.idCallerBlock}`);
  if (exceptRooms.length > 0) {
    io.except(exceptRooms).emit('presence:updated', payload);
  } else {
    io.emit('presence:updated', payload);
  }
};

module.exports = {
  isBlockedBy,
  isBlockedEitherWay,
  getBlockPair,
  getBlockDate,
  getDirectConversationPeer,
  getCachedDirectConversationPeer,
  evaluateDirectMessageSend,
  shouldSuppressDirectInteraction,
  maskPresenceIfBlocked,
  emitPresenceUpdate,
};
