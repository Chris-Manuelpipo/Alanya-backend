const assert = require('assert');
const {
  isConversationMuted,
  applyPreviewPolicy,
} = require('./notificationPrefs');

// muteForever
assert.strictEqual(
  isConversationMuted({ muteForever: 1, mutedUntil: null }),
  true,
);

// mutedUntil futur
const future = new Date(Date.now() + 60_000).toISOString();
assert.strictEqual(
  isConversationMuted({ muteForever: 0, mutedUntil: future }),
  true,
);

// mutedUntil passé
const past = new Date(Date.now() - 60_000).toISOString();
assert.strictEqual(
  isConversationMuted({ muteForever: 0, mutedUntil: past }),
  false,
);

// preview generic
const generic = applyPreviewPolicy(
  { previewMode: 'generic' },
  { title: 'Alice', body: 'Secret', senderName: 'Alice', isGroup: false },
);
assert.strictEqual(generic.title, 'Alanya');
assert.strictEqual(generic.body, 'Nouveau message');

console.log('notificationPrefs.test.js OK');
