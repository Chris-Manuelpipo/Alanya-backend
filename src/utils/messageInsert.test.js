const assert = require('assert');
const { MESSAGE_INSERT_SQL, messageInsertParams, insertMessageThumb } = require('./messageInsert');

const placeholders = (MESSAGE_INSERT_SQL.match(/\?/g) || []).length;
const sendAt = new Date('2026-09-01T10:00:00.000Z');
const params = messageInsertParams({
  senderID: 1,
  conversationID: 2,
  clientId: 'notif_1_2',
  content: 'salut',
  type: 0,
  sendAt,
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
  19,
  `INSERT : 19 placeholders attendus, ${placeholders} trouvés`,
);
assert.strictEqual(
  params.length,
  placeholders,
  `INSERT : ${params.length} params pour ${placeholders} placeholders`,
);

// sendAt occupe la 6e position (après status, littéral) et porte bien la date
// fournie : c'est elle que l'appelant renvoie dans l'accusé sans relire la ligne.
assert.strictEqual(
  params[5].getTime(),
  sendAt.getTime(),
  'sendAt doit être le 6e paramètre, à la valeur fournie',
);

// Jamais null : l'appelant peut l'omettre, la ligne doit rester triable.
const sansSendAt = messageInsertParams({
  senderID: 1, conversationID: 2, clientId: 'c', content: 'x', type: 0,
  clickSentAt: null, mediaUrl: null, mediaName: null, mediaDuration: null,
  mediaSize: null, mediaPageCount: null, replyToID: null, replyToContent: null,
  isStatusReply: 0, isForwarded: 0, isViewOnce: 0, mentionsSerialized: null,
});
assert.ok(sansSendAt[5] instanceof Date, 'sendAt omis doit retomber sur maintenant');

const cols = MESSAGE_INSERT_SQL.match(/INSERT INTO message\s*\(([^)]+)\)/s)[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
assert.strictEqual(cols.length, 20, '20 colonnes (status en littéral, mediaThumb exclue)');
assert.ok(
  !/NOW\(\)/.test(MESSAGE_INSERT_SQL),
  'sendAt doit être un paramètre, pas NOW() : sinon l\'accusé ne peut pas connaître la date sans relire la ligne',
);
assert.ok(!cols.includes('mediaThumb'), 'mediaThumb ne doit plus faire partie de l\'INSERT message');
assert.ok(MESSAGE_INSERT_SQL.includes('ON DUPLICATE KEY UPDATE'));

// ── enc_version (migration 091) ───────────────────────────────────────────
//
// Elle est DANS l'INSERT et non posée par un UPDATE qui suivrait : entre les
// deux écritures, une relecture concurrente verrait un message annoncé en
// clair dont `content` est NULL — donc une bulle vide.
assert.strictEqual(
  cols[cols.length - 1], 'enc_version',
  'enc_version doit être la dernière colonne, pour correspondre au dernier param',
);

const champsMinimaux = {
  senderID: 1, conversationID: 2, clientId: 'c', content: null, type: 0,
  clickSentAt: null, mediaUrl: null, mediaName: null, mediaDuration: null,
  mediaSize: null, mediaPageCount: null, replyToID: null, replyToContent: null,
  isStatusReply: 0, isForwarded: 0, isViewOnce: 0, mentionsSerialized: null,
};
const dernier = (champs) => {
  const p = messageInsertParams(champs);
  return p[p.length - 1];
};

// Les appelants qui ne chiffrent pas — messages système, bienvenue,
// diffusions, trajets, traces d'appel — ne passent rien du tout.
assert.strictEqual(
  dernier(champsMinimaux), 0,
  'encVersion omis doit valoir 0 : « en clair », ce que sont ces messages',
);
assert.strictEqual(dernier({ ...champsMinimaux, encVersion: 1 }), 1);
// Strictement 1 ou 0 : une valeur inattendue ne doit pas devenir « chiffré »
// par la grâce d'un test de véracité. Un message annoncé chiffré sans corps
// dans `message_e2ee` est illisible pour tout le monde, définitivement.
assert.strictEqual(dernier({ ...champsMinimaux, encVersion: 2 }), 0);
assert.strictEqual(dernier({ ...champsMinimaux, encVersion: true }), 0);
assert.strictEqual(dernier({ ...champsMinimaux, encVersion: '1' }), 0);

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
