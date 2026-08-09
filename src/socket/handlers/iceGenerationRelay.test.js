// Vérifie que generation est préservée dans les payloads relayés (helpers locaux).
const assert = require('assert');

function relayPayload(base, data) {
  return {
    ...base,
    ...(data?.generation != null ? { generation: data.generation } : {}),
    ...(data?.callId != null ? { callId: data.callId } : {}),
  };
}

const withGen = relayPayload({ candidate: { c: 1 } }, { generation: 2, callId: '1329' });
assert.strictEqual(withGen.generation, 2);
assert.strictEqual(withGen.callId, '1329');
assert.deepStrictEqual(withGen.candidate, { c: 1 });

const without = relayPayload({ offer: {} }, {});
assert.strictEqual(without.generation, undefined);

const zero = relayPayload({ offer: {} }, { generation: 0 });
assert.strictEqual(zero.generation, 0, 'generation 0 doit être relayée');

console.log('iceGenerationRelay.test.js OK');
