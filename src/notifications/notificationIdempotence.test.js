/**
 * Idempotence reply/read — contrat clientId (sans DB).
 * Reflète la règle messageController : même sender + clientId → réutiliser.
 */
const assert = require('assert');

const resolveClientId = (body = {}) => {
  const raw = body.clientId ?? body.clientID ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s.slice(0, 128) : null;
};

const findExistingByClientId = (store, senderId, clientId) => {
  if (!clientId) return null;
  return (
    store.find(
      (m) =>
        Number(m.senderId) === Number(senderId) &&
        String(m.clientId) === String(clientId),
    ) ?? null
  );
};

const upsertMessage = (store, { senderId, clientId, content }) => {
  const existing = findExistingByClientId(store, senderId, clientId);
  if (existing) {
    return { created: false, message: existing };
  }
  const message = {
    msgID: store.length + 1,
    senderId,
    clientId,
    content,
  };
  store.push(message);
  return { created: true, message };
};

// resolveClientId
assert.strictEqual(resolveClientId({ clientId: '  abc  ' }), 'abc');
assert.strictEqual(resolveClientId({ clientID: 'xyz' }), 'xyz');
assert.strictEqual(resolveClientId({}), null);
assert.strictEqual(resolveClientId({ clientId: '   ' }), null);

// double reply same clientId → one message
const store = [];
const r1 = upsertMessage(store, {
  senderId: 10,
  clientId: 'notif_reply_1',
  content: 'Salut',
});
const r2 = upsertMessage(store, {
  senderId: 10,
  clientId: 'notif_reply_1',
  content: 'Salut',
});
assert.strictEqual(r1.created, true);
assert.strictEqual(r2.created, false);
assert.strictEqual(r1.message.msgID, r2.message.msgID);
assert.strictEqual(store.length, 1);

// different clientId → second message
const r3 = upsertMessage(store, {
  senderId: 10,
  clientId: 'notif_reply_2',
  content: 'Autre',
});
assert.strictEqual(r3.created, true);
assert.strictEqual(store.length, 2);

// same clientId other sender → allowed
const r4 = upsertMessage(store, {
  senderId: 11,
  clientId: 'notif_reply_1',
  content: 'Salut',
});
assert.strictEqual(r4.created, true);
assert.strictEqual(store.length, 3);

console.log('notificationIdempotence.test.js OK');
