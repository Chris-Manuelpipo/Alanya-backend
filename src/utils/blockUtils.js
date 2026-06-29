const pool = require('../config/db');

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

/** Autre participant d'une conv. 1-1, ou null si groupe / introuvable */
const getDirectConversationPeer = async (conversationID, userId) => {
  const [conv] = await pool.execute(
    'SELECT isGroup FROM conversation WHERE conversID = ?',
    [conversationID],
  );
  if (!conv.length || conv[0].isGroup) return null;

  const [parts] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, userId],
  );
  return parts.length === 1 ? Number(parts[0].alanyaID) : null;
};

/**
 * Évalue les règles de blocage pour un envoi 1-1.
 * action: 'deliver' | 'reject' | 'silent'
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

module.exports = {
  isBlockedBy,
  isBlockedEitherWay,
  getBlockPair,
  getBlockDate,
  getDirectConversationPeer,
  evaluateDirectMessageSend,
  shouldSuppressDirectInteraction,
};
