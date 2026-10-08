const assert = require('assert');
const {
  MESSAGE_INSERT_SQL,
  MESSAGE_INSERT_CHIFFRE_SQL,
  messageInsertSql,
  messageInsertParams,
  insertMessageThumb,
} = require('./messageInsert');

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
  18,
  `INSERT : 18 placeholders attendus, ${placeholders} trouvés`,
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

const colonnes = (sql) => sql.match(/INSERT INTO message\s*\(([^)]+)\)/s)[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const cols = colonnes(MESSAGE_INSERT_SQL);
assert.strictEqual(cols.length, 19, '19 colonnes (status en littéral, mediaThumb exclue)');
assert.ok(
  !/NOW\(\)/.test(MESSAGE_INSERT_SQL),
  'sendAt doit être un paramètre, pas NOW() : sinon l\'accusé ne peut pas connaître la date sans relire la ligne',
);
assert.ok(!cols.includes('mediaThumb'), 'mediaThumb ne doit plus faire partie de l\'INSERT message');
assert.ok(MESSAGE_INSERT_SQL.includes('ON DUPLICATE KEY UPDATE'));

// ── enc_version (migration 092) ───────────────────────────────────────────
//
// La forme en clair ne nomme pas la colonne : c'est ce qui la rend
// indépendante de l'ordre de déploiement. Poussée avant la migration 092, elle
// doit continuer d'écrire tous les messages en clair.
assert.ok(
  !cols.includes('enc_version'),
  'la forme en clair ne doit pas dépendre de la colonne enc_version',
);

// La forme chiffrée la pose DANS l'INSERT et non par un UPDATE qui suivrait :
// entre les deux écritures, une relecture concurrente verrait un message
// annoncé en clair dont `content` est NULL — donc une bulle vide.
const colsChiffre = colonnes(MESSAGE_INSERT_CHIFFRE_SQL);
assert.strictEqual(colsChiffre.length, 20);
assert.strictEqual(colsChiffre[colsChiffre.length - 1], 'enc_version');
assert.deepStrictEqual(colsChiffre.slice(0, -1), cols, 'mêmes colonnes, plus enc_version');
// Littéral, comme `status` : les deux formes prennent les mêmes paramètres.
assert.strictEqual((MESSAGE_INSERT_CHIFFRE_SQL.match(/\?/g) || []).length, placeholders);
assert.ok(/\?, 1\)\s*ON DUPLICATE KEY UPDATE/.test(MESSAGE_INSERT_CHIFFRE_SQL));
assert.ok(MESSAGE_INSERT_CHIFFRE_SQL.includes('ON DUPLICATE KEY UPDATE'));

// Choix de la forme : chiffrée seulement quand il y a un corps.
assert.strictEqual(messageInsertSql(null), MESSAGE_INSERT_SQL);
assert.strictEqual(messageInsertSql(undefined), MESSAGE_INSERT_SQL);
assert.strictEqual(messageInsertSql({ body: Buffer.from('x') }), MESSAGE_INSERT_CHIFFRE_SQL);

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
