const assert = require('assert');
const { MESSAGE_INSERT_SQL, messageInsertParams, insertMessageThumb } = require('./messageInsert');

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
  17,
  `INSERT : 17 placeholders attendus, ${placeholders} trouvés`,
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
assert.strictEqual(cols.length, 19, '19 colonnes (status et sendAt en littéraux, mediaThumb exclue)');
assert.ok(!cols.includes('mediaThumb'), 'mediaThumb ne doit plus faire partie de l\'INSERT message');
assert.ok(MESSAGE_INSERT_SQL.includes('ON DUPLICATE KEY UPDATE'));

// insertMessageThumb : no-op silencieux si aucune vignette fournie.
(async () => {
  let called = false;
  const fakeConn = { execute: async () => { called = true; } };
  await insertMessageThumb(fakeConn, 42, null);
  assert.strictEqual(called, false, 'insertMessageThumb ne doit rien exécuter sans mediaThumb');

  await insertMessageThumb(fakeConn, 42, 'aGVsbG8=');
  assert.strictEqual(called, true, 'insertMessageThumb doit écrire quand mediaThumb est fourni');

  console.log('messageInsert.test.js OK');
})();
