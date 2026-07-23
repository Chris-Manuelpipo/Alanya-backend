const assert = require('assert');
const { attachParticipantsBatch } = require('./conversationParticipantsBatch');

/** Fake pool qui compte les execute et renvoie des fixtures. */
function makeFakePool({ partRows = [], blockedRows = [], blockPairRows = [] } = {}) {
  let executeCount = 0;
  const queries = [];
  return {
    get executeCount() {
      return executeCount;
    },
    get queries() {
      return queries;
    },
    async execute(sql, params) {
      executeCount += 1;
      queries.push({ sql, params });
      if (sql.includes('FROM conv_participants')) {
        return [partRows];
      }
      if (sql.includes('FROM blocked WHERE idCallerBlock = ?')) {
        return [blockedRows];
      }
      if (sql.includes('FROM blocked')) {
        return [blockPairRows];
      }
      return [[]];
    },
  };
}

const sanitizeUrl = (url) => (url && String(url).startsWith('http') ? url : null);

const run = async () => {
  // 50 convs 1-1 → ≤ 3 requêtes (participants + blocked viewer + block pairs)
  const viewerId = 1;
  const rows = [];
  const partRows = [];
  for (let i = 0; i < 50; i++) {
    const convId = 1000 + i;
    const peerId = 2000 + i;
    rows.push({ conversID: convId, isGroup: 0, lastMessageAt: new Date() });
    partRows.push({
      conversID: convId,
      alanyaID: viewerId,
      nom: 'Me',
      pseudo: 'me',
      avatar_url: 'http://a/me.png',
      alanyaPhone: '1',
      is_online: 1,
      last_seen: null,
    });
    partRows.push({
      conversID: convId,
      alanyaID: peerId,
      nom: `Peer${i}`,
      pseudo: `p${i}`,
      avatar_url: 'http://a/p.png',
      alanyaPhone: String(peerId),
      is_online: 1,
      last_seen: null,
    });
  }

  // Peer 2000 a bloqué le viewer → présence masquée
  // Viewer a bloqué peer 2001 → isBlocked
  const pool = makeFakePool({
    partRows,
    blockedRows: [{ alanyaID: 2000 }],
    blockPairRows: [
      { alanyaID: 2000, idCallerBlock: viewerId },
      { alanyaID: viewerId, idCallerBlock: 2001 },
    ],
  });

  const enriched = await attachParticipantsBatch(pool, rows, viewerId, sanitizeUrl);

  assert.ok(pool.executeCount <= 3, `expected ≤3 queries, got ${pool.executeCount}`);
  assert.strictEqual(enriched.length, 50);
  assert.strictEqual(enriched[0].participants.length, 2);

  const peer0 = enriched[0].participants.find((p) => Number(p.alanyaID) === 2000);
  assert.strictEqual(peer0.is_online, 0);
  assert.strictEqual(peer0.last_seen, null);
  assert.strictEqual(enriched[0].blockStatus.blockedByThem, true);

  const peer1 = enriched[1].participants.find((p) => Number(p.alanyaID) === 2001);
  assert.strictEqual(peer1.is_online, 1);
  assert.strictEqual(enriched[1].blockStatus.isBlocked, true);

  // Empty input
  const emptyPool = makeFakePool();
  const empty = await attachParticipantsBatch(emptyPool, [], viewerId, sanitizeUrl);
  assert.deepStrictEqual(empty, []);
  assert.strictEqual(emptyPool.executeCount, 0);

  console.log('conversationParticipantsBatch.test.js: OK');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
