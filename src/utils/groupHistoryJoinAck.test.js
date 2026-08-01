const assert = require('assert');
const { HISTORY_CUTOFF_SQL } = require('./messageHistoryFilter');
const { evaluateJoinAckMessage } = require('./groupJoinAck');

assert.ok(
  HISTORY_CUTOFF_SQL.includes('cp.historyCutoffAt IS NULL'),
  'NULL cutoff = historique complet',
);
assert.ok(
  HISTORY_CUTOFF_SQL.includes('m.sendAt >= cp.historyCutoffAt'),
  '>= pour inclure le member_added écrit à l\'ajout',
);
assert.ok(
  !HISTORY_CUTOFF_SQL.includes('m.sendAt > cp.historyCutoffAt'),
  'ne pas exclure le message système à sendAt == cutoff',
);

assert.strictEqual(
  evaluateJoinAckMessage({
    type: 6,
    content: JSON.stringify({ e: 'member_added', by: 1, ids: [42, 7] }),
    viewerId: 42,
  }),
  'ok',
);

assert.strictEqual(
  evaluateJoinAckMessage({
    type: 6,
    content: JSON.stringify({ e: 'member_added', by: 1, ids: [7] }),
    viewerId: 42,
  }),
  'invalid',
  'viewer absent de ids',
);

assert.strictEqual(
  evaluateJoinAckMessage({
    type: 6,
    content: JSON.stringify({ e: 'member_left', by: 42, ids: [42] }),
    viewerId: 42,
  }),
  'invalid',
  'mauvais événement',
);

assert.strictEqual(
  evaluateJoinAckMessage({ type: 1, content: '{}', viewerId: 42 }),
  'missing',
  'pas un message système',
);

assert.strictEqual(
  evaluateJoinAckMessage({ type: 6, content: 'not-json', viewerId: 42 }),
  'invalid',
);

assert.strictEqual(
  evaluateJoinAckMessage({
    type: 6,
    content: JSON.stringify({ e: 'member_added', by: 1, ids: ['42'] }),
    viewerId: 42,
  }),
  'ok',
  'ids numériques en string acceptés',
);

console.log('messageHistoryFilter + groupJoinAck: ok');
