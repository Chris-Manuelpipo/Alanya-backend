const assert = require('assert');
const {
  buildMessagePayload,
  buildMessageReadSyncPayload,
  normalizeIncomingPayload,
  isV2Payload,
  stringifyData,
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

  assert.strictEqual(isV2Payload(direct), true);
  assert.strictEqual(isV2Payload(legacy), false);

  console.log('notificationContract.test.js: OK');
};

run();
