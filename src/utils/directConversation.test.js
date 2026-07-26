const assert = require('assert');
const {
  SELF_CHAT_MARKER,
  buildDirectConversationLookup,
  isSelfChatRow,
  dedupeDirectConversations,
} = require('./directConversation');

const selfRow = (over = {}) => ({
  conversID: 1,
  isGroup: 0,
  GroupName: SELF_CHAT_MARKER,
  participants: [{ alanyaID: 1, nom: 'Moi' }],
  messageCount: 0,
  lastMessageAt: null,
  isPinned: 0,
  ...over,
});

const peerRow = (over = {}) => ({
  conversID: 10,
  isGroup: 0,
  GroupName: null,
  participants: [{ alanyaID: 1, nom: 'Moi' }, { alanyaID: 2, nom: 'Bob' }],
  messageCount: 0,
  lastMessageAt: null,
  isPinned: 0,
  ...over,
});

const run = async () => {
  const ME = 1;

  // ── buildDirectConversationLookup ──────────────────────────────────────
  const self = buildDirectConversationLookup({ meId: ME, peerId: ME });
  assert.strictEqual(self.isSelf, true);
  assert.ok(self.sql.includes('c.GroupName = ?'), 'branche self : filtre sur le marqueur');
  assert.ok(!self.sql.includes('cp2'), 'branche self : pas de double jointure');
  assert.deepStrictEqual(self.params, [ME, SELF_CHAT_MARKER]);

  const peer = buildDirectConversationLookup({ meId: ME, peerId: 2 });
  assert.strictEqual(peer.isSelf, false);
  // Ceinture : la double jointure ne peut plus se replier sur une seule ligne.
  assert.ok(peer.sql.includes('cp1.id <> cp2.id'), 'branche pair : cp1.id <> cp2.id');
  // Bretelles : un self-chat ne doit jamais ressortir comme 1-1 avec un tiers.
  assert.ok(
    peer.sql.includes('c.GroupName IS NULL OR c.GroupName <> ?'),
    'branche pair : exclusion du marqueur',
  );
  assert.deepStrictEqual(peer.params, [ME, 2, SELF_CHAT_MARKER]);

  // Identifiants passés en chaîne (req.body) : la comparaison reste numérique.
  assert.strictEqual(buildDirectConversationLookup({ meId: '7', peerId: 7 }).isSelf, true);

  // ── isSelfChatRow ──────────────────────────────────────────────────────
  assert.strictEqual(isSelfChatRow(selfRow()), true);
  assert.strictEqual(isSelfChatRow(peerRow()), false);
  // Un groupe nommé « __self__ » reste un groupe.
  assert.strictEqual(isSelfChatRow({ isGroup: 1, GroupName: SELF_CHAT_MARKER }), false);

  // ── dedupeDirectConversations ──────────────────────────────────────────
  // Deux self-chats (doublon accidentel) → le plus fourni gagne.
  const dupSelf = dedupeDirectConversations(
    [
      selfRow({ conversID: 1, messageCount: 2 }),
      selfRow({ conversID: 5, messageCount: 9 }),
    ],
    ME,
  );
  assert.strictEqual(dupSelf.length, 1);
  assert.strictEqual(dupSelf[0].conversID, 5);

  // Self-chat + deux doublons 1-1 avec le même pair → 1 self + 1 pair.
  const mixed = dedupeDirectConversations(
    [
      selfRow({ conversID: 1, messageCount: 3 }),
      peerRow({ conversID: 10, messageCount: 1 }),
      peerRow({ conversID: 11, messageCount: 8 }),
    ],
    ME,
  );
  assert.strictEqual(mixed.length, 2);
  assert.ok(mixed.some((r) => r.conversID === 1), 'le self-chat survit');
  assert.ok(mixed.some((r) => r.conversID === 11), 'le 1-1 le plus fourni survit');
  assert.ok(!mixed.some((r) => r.conversID === 10), 'le doublon 1-1 disparaît');

  // Conv orpheline (le pair a supprimé son côté) : même forme qu'un self-chat
  // mais SANS marqueur → conservée telle quelle, jamais fusionnée avec le self.
  const orphan = {
    conversID: 20,
    isGroup: 0,
    GroupName: null,
    participants: [{ alanyaID: ME, nom: 'Moi' }],
    messageCount: 4,
    lastMessageAt: null,
    isPinned: 0,
  };
  const withOrphan = dedupeDirectConversations([selfRow({ conversID: 1 }), orphan], ME);
  assert.strictEqual(withOrphan.length, 2, 'orpheline et self-chat coexistent');
  assert.ok(withOrphan.some((r) => r.conversID === 20));
  assert.ok(withOrphan.some((r) => r.conversID === 1));

  // Un groupe traverse sans être touché.
  const withGroup = dedupeDirectConversations(
    [{ conversID: 30, isGroup: 1, GroupName: 'Équipe', isPinned: 0, lastMessageAt: null }],
    ME,
  );
  assert.strictEqual(withGroup.length, 1);
  assert.strictEqual(withGroup[0].conversID, 30);

  console.log('directConversation.test.js: OK');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
