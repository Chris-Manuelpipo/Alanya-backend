const assert = require('assert');
const { evaluateMessagePush } = require('./notificationFilter');

// Une discussion archivée ne notifie plus, sauf mention (groupe 3GI 2029,
// bug A13). Tout est préchargé : le filtre ne touche pas la base.
const basePrefs = {
  messagesEnabled: 1,
  groupMessagesEnabled: 1,
  soundEnabled: 1,
  previewMode: 'full',
};

const payload = () => ({
  type: 'message',
  conversationId: '316',
  senderId: '3',
  senderName: 'Alice',
  title: '3GI 2029',
  body: 'Bonjour',
});

const evaluate = ({ mute = {}, ...options } = {}) =>
  evaluateMessagePush(1, 316, payload(), {
    isGroup: true,
    ...options,
    preloaded: { prefs: basePrefs, dnd: { enabled: 0 }, mute },
  });

const run = async () => {
  const normal = await evaluate();
  assert.strictEqual(normal.allowed, true);
  assert.ok(!normal.silent, 'discussion non archivée : notification visible');

  const archived = await evaluate({ mute: { isArchived: 1 } });
  assert.strictEqual(archived.silent, true, 'archivée : push silencieuse');
  assert.strictEqual(archived.reason, 'conversation_archived');
  assert.ok(!('body' in archived.payload), 'contenu retiré');
  assert.strictEqual(archived.allowed, true, 'push silencieuse gardée pour l\'accusé de remise');

  const mentioned = await evaluate({ mute: { isArchived: 1 }, isMentioned: true });
  assert.ok(!mentioned.silent, 'une mention perce l\'archivage');

  console.log('notificationArchived.test.js OK');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
