const assert = require('assert');
const {
  buildMessagePayload,
  buildMessageReadSyncPayload,
  normalizeIncomingPayload,
  isV2Payload,
  stringifyData,
  sanitizeAvatarUrl,
} = require('./notificationContract');

const run = () => {
  // Direct message
  const direct = buildMessagePayload({
    msgID: 123,
    conversationId: 45,
    senderId: 10,
    senderName: 'Alice',
    body: 'Bonjour',
    msgType: 0,
    clientId: 'c_abc',
    unreadTotal: 5,
    eventId: 'notif_test_1',
  });
  assert.strictEqual(direct.schemaVersion, '2');
  assert.strictEqual(direct.type, 'message');
  assert.strictEqual(direct.msgID, '123');
  assert.strictEqual(direct.conversationId, '45');
  assert.strictEqual(direct.senderId, '10');
  assert.strictEqual(direct.title, 'Alice');
  assert.strictEqual(direct.body, 'Bonjour');
  assert.strictEqual(direct.isGroup, '0');
  assert.strictEqual(direct.eventId, 'notif_test_1');
  assert.strictEqual(direct.callerId, '10');
  assert.strictEqual(typeof direct.sentAt, 'string');

  // Group message
  const group = buildMessagePayload({
    msgID: 1,
    conversationId: 2,
    senderId: 3,
    senderName: 'Bob',
    body: 'Hello team',
    isGroup: true,
    groupName: 'Equipe',
  });
  assert.strictEqual(group.title, 'Equipe');
  assert.strictEqual(group.body, 'Bob: Hello team');
  assert.strictEqual(group.isGroup, '1');
  assert.strictEqual(group.groupName, 'Equipe');

  // Media type as number
  const media = buildMessagePayload({
    msgID: 9,
    conversationId: 1,
    senderId: 2,
    senderName: 'X',
    body: '📷 Photo',
    msgType: 1,
  });
  assert.strictEqual(media.msgType, '1');

  // stringifyData
  const str = stringifyData({ a: 1, b: true, c: null, d: undefined, e: 'x' });
  assert.deepStrictEqual(str, { a: '1', b: 'true', e: 'x' });

  // Legacy normalize
  const legacy = normalizeIncomingPayload({
    type: 'message',
    title: 'Old',
    body: 'Hi',
    conversationId: 7,
    callerId: '99',
  });
  assert.strictEqual(legacy.schemaVersion, '1');
  assert.strictEqual(legacy.conversationId, '7');
  assert.strictEqual(legacy.type, 'message');

  // Incomplete payload
  const incomplete = normalizeIncomingPayload({});
  assert.strictEqual(incomplete.type, 'message');
  assert.strictEqual(incomplete.schemaVersion, '1');

  // read sync
  const readSync = buildMessageReadSyncPayload({ conversationId: 12, msgID: 34 });
  assert.strictEqual(readSync.type, 'message_read_sync');
  assert.strictEqual(readSync.conversationId, '12');
  assert.ok(!('unreadTotal' in readSync), 'unreadTotal absent si non fourni');

  const readSyncBadge = buildMessageReadSyncPayload({
    conversationId: 12, msgID: 34, unreadTotal: 3,
  });
  assert.strictEqual(readSyncBadge.unreadTotal, '3', 'badge porté par la sync');

  assert.strictEqual(isV2Payload(direct), true);
  assert.strictEqual(isV2Payload(legacy), false);

  // msgID / clientId : `stringifyData` supprime les clés undefined, donc un
  // appelant qui ne les passe pas produit un payload SANS msgID. La
  // déduplication client retombe alors sur `eventId`, régénéré à chaque envoi,
  // et redevient inopérante. C'était le cas du chemin HTTP — celui de la réponse
  // rapide depuis la notification.
  const withIds = buildMessagePayload({
    conversationId: 7, senderId: 3, senderName: 'A', body: 'x',
    msgID: 42, clientId: 'notif_1_7',
  });
  assert.strictEqual(withIds.msgID, '42');
  assert.strictEqual(withIds.clientId, 'notif_1_7');

  const withoutIds = buildMessagePayload({
    conversationId: 7, senderId: 3, senderName: 'A', body: 'x',
  });
  assert.strictEqual(withoutIds.msgID, undefined, 'msgID absent si non fourni');
  assert.ok(!('msgID' in withoutIds), 'la clé msgID est retirée, pas mise à vide');

  // ── Avatars ────────────────────────────────────────────────────────────
  // Une sentinelle non filtrée est pire qu'une absence : elle rend le champ
  // truthy, donc pose `mutable-content: 1` sur iOS et déclenche un
  // téléchargement Android, pour une URL qui n'en est pas une.
  assert.strictEqual(sanitizeAvatarUrl('NON DEFINI'), '');
  assert.strictEqual(sanitizeAvatarUrl('indefini'), '');
  assert.strictEqual(sanitizeAvatarUrl('undefined'), '');
  assert.strictEqual(sanitizeAvatarUrl('null'), '');
  assert.strictEqual(sanitizeAvatarUrl('  '), '');
  assert.strictEqual(sanitizeAvatarUrl(null), '');
  assert.strictEqual(sanitizeAvatarUrl(undefined), '');

  // Ancien hôte réécrit vers le domaine actuel, en http comme en https.
  assert.strictEqual(
    sanitizeAvatarUrl('https://158.220.107.211/uploads/images/a.jpg'),
    'https://www.alanya237.com/uploads/images/a.jpg',
  );
  assert.strictEqual(
    sanitizeAvatarUrl('http://158.220.107.211/uploads/images/a.jpg'),
    'https://www.alanya237.com/uploads/images/a.jpg',
  );

  // http rejeté : Android l'accepterait, iOS non (ATS).
  assert.strictEqual(sanitizeAvatarUrl('http://exemple.test/a.jpg'), '');
  assert.strictEqual(sanitizeAvatarUrl('/uploads/images/a.jpg'), '');

  const ok = 'https://www.alanya237.com/uploads/images/a.jpg';
  assert.strictEqual(sanitizeAvatarUrl(ok), ok);
  assert.strictEqual(sanitizeAvatarUrl(`  ${ok}  `), ok);

  // Le contrat applique l'assainissement, quel que soit l'appelant.
  const avatars = buildMessagePayload({
    conversationId: 1, senderId: 2, senderName: 'A', body: 'x',
    senderAvatar: 'NON DEFINI',
    groupAvatar: 'https://158.220.107.211/uploads/images/g.jpg',
    isGroup: true,
    groupName: 'Equipe',
  });
  assert.strictEqual(avatars.senderAvatar, '', 'sentinelle → chaîne vide');
  assert.strictEqual(
    avatars.groupAvatar,
    'https://www.alanya237.com/uploads/images/g.jpg',
    'hôte legacy réécrit dans le payload',
  );

  console.log('notificationContract.test.js: OK');
};

run();
