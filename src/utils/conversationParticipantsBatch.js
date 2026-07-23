/**
 * Batch attachment of participants + block status for conversation list.
 * Replaces N+1 attachParticipantsMany with ≤ 3 SQL queries.
 */

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object[]} rows conversation rows
 * @param {number|null} viewerId
 * @param {(url: string|null|undefined) => string|null} sanitizeUrl
 */
async function attachParticipantsBatch(pool, rows, viewerId, sanitizeUrl) {
  if (!rows || rows.length === 0) return rows;

  const convIds = rows.map((r) => Number(r.conversID)).filter((id) => id > 0);
  if (convIds.length === 0) {
    for (const row of rows) row.participants = [];
    return rows;
  }

  const placeholders = convIds.map(() => '?').join(',');

  // 1) Tous les participants en une requête
  const [partRows] = await pool.execute(
    `SELECT cp.conversID, u.alanyaID, u.nom, u.pseudo, u.avatar_url,
            u.alanyaPhone, u.is_online, u.last_seen
     FROM conv_participants cp
     JOIN users u ON cp.alanyaID = u.alanyaID
     WHERE cp.conversID IN (${placeholders})`,
    convIds,
  );

  const byConv = new Map();
  for (const p of partRows) {
    const cid = Number(p.conversID);
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid).push(p);
  }

  // Peer IDs des convs 1-1 (pour blockStatus)
  const peerIds = new Set();
  for (const row of rows) {
    if (row.isGroup || viewerId == null) continue;
    const parts = byConv.get(Number(row.conversID)) || [];
    for (const p of parts) {
      if (Number(p.alanyaID) !== Number(viewerId)) {
        peerIds.add(Number(p.alanyaID));
      }
    }
  }

  // 2) Qui a bloqué le viewer (masquage présence) — 1 requête
  let blockedViewerSet = new Set();
  if (viewerId != null) {
    const [blockedRows] = await pool.execute(
      'SELECT alanyaID FROM blocked WHERE idCallerBlock = ?',
      [viewerId],
    );
    blockedViewerSet = new Set(blockedRows.map((r) => Number(r.alanyaID)));
  }

  // 3) Block pairs viewer ↔ peers 1-1 — 1 requête
  const blockByPeer = new Map();
  if (viewerId != null && peerIds.size > 0) {
    const peers = [...peerIds];
    const peerPh = peers.map(() => '?').join(',');
    const [blockRows] = await pool.execute(
      `SELECT alanyaID, idCallerBlock FROM blocked
       WHERE (alanyaID = ? AND idCallerBlock IN (${peerPh}))
          OR (idCallerBlock = ? AND alanyaID IN (${peerPh}))`,
      [viewerId, ...peers, viewerId, ...peers],
    );
    for (const peerId of peers) {
      blockByPeer.set(peerId, { iBlockedThem: false, theyBlockedMe: false });
    }
    for (const r of blockRows) {
      const a = Number(r.alanyaID);
      const b = Number(r.idCallerBlock);
      if (a === Number(viewerId) && blockByPeer.has(b)) {
        blockByPeer.get(b).iBlockedThem = true;
      }
      if (b === Number(viewerId) && blockByPeer.has(a)) {
        blockByPeer.get(a).theyBlockedMe = true;
      }
    }
  }

  for (const row of rows) {
    const cid = Number(row.conversID);
    const parts = byConv.get(cid) || [];
    const participants = [];
    for (const p of parts) {
      const subjectId = Number(p.alanyaID);
      let isOnline = p.is_online;
      let lastSeen = p.last_seen;
      if (
        viewerId != null &&
        subjectId !== Number(viewerId) &&
        blockedViewerSet.has(subjectId)
      ) {
        isOnline = 0;
        lastSeen = null;
      }
      participants.push({
        alanyaID: p.alanyaID,
        nom: p.nom,
        pseudo: p.pseudo,
        avatar_url: sanitizeUrl(p.avatar_url),
        alanyaPhone: p.alanyaPhone,
        is_online: isOnline,
        last_seen: lastSeen,
      });

      if (
        viewerId != null &&
        !row.isGroup &&
        subjectId !== Number(viewerId)
      ) {
        const pair = blockByPeer.get(subjectId) || {
          iBlockedThem: false,
          theyBlockedMe: false,
        };
        row.blockStatus = {
          isBlocked: pair.iBlockedThem,
          blockedByThem: pair.theyBlockedMe,
        };
      }
    }
    row.participants = participants;
  }

  return rows;
}

module.exports = { attachParticipantsBatch };
