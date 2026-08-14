const assert = require('assert');
const { MESSAGE_INSERT_SQL, messageInsertParams } = require('./messageInsert');

const placeholders = (MESSAGE_INSERT_SQL.match(/\?/g) || []).length;
const params = messageInsertParams({
  senderID: 1,
  conversationID: 2,
  clientId: 'notif_1_2',
  content: 'salut',
  type: 0,
  clickSentAt: null,
  mediaUrl: null,
  mediaName: null,
  mediaDuration: null,
  mediaThumb: null,
  mediaSize: null,
  mediaPageCount: null,
  replyToID: null,
  replyToContent: null,
  isStatusReply: 0,
  isForwarded: 0,
  isViewOnce: 0,
  mentionsSerialized: null,
});

assert.strictEqual(
  placeholders,
  18,
  `INSERT : 18 placeholders attendus, ${placeholders} trouvés`,
);
assert.strictEqual(
  params.length,
  placeholders,
  `INSERT : ${params.length} params pour ${placeholders} placeholders`,
);

const cols = MESSAGE_INSERT_SQL.match(/INSERT INTO message\s*\(([^)]+)\)/s)[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
assert.strictEqual(cols.length, 20, '20 colonnes (status et sendAt en littéraux)');
assert.ok(MESSAGE_INSERT_SQL.includes('ON DUPLICATE KEY UPDATE'));

console.log('messageInsert.test.js OK');
