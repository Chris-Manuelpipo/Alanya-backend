// Routes HEVC : validation de la déclaration, réponse par discussion. Le
// service est un double : on éprouve le contrôleur.
const assert = require('assert');

const calls = { allow: [], record: [] };
let allow = true;
const p = require.resolve('../services/videoCodecs');
require.cache[p] = {
  id: p, filename: p, loaded: true,
  exports: {
    conversationAllowsHevc: async (id) => { calls.allow.push(id); return allow; },
    recordDeviceCapabilities: async (args) => { calls.record.push(args); return true; },
  },
};
const { getConversationVideoCodecs, putVideoCapabilities } = require('./videoCodecsController');

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

(async () => {
  // Décision par discussion : celle de l'appartenance vérifiée.
  let r = res();
  await getConversationVideoCodecs({ membership: { conversID: 12 }, params: { id: '12' } }, r);
  assert.deepStrictEqual(r.body, { hevc: true });
  assert.deepStrictEqual(calls.allow, [12]);
  allow = false;
  r = res();
  await getConversationVideoCodecs({ membership: { conversID: 12 }, params: { id: '12' } }, r);
  assert.deepStrictEqual(r.body, { hevc: false });

  // Déclaration : un booléen, pour l'appareil du jeton.
  const user = { alanyaID: 7, appareilId: 3 };
  r = res();
  await putVideoCapabilities({ user, body: { hevcDecode: true } }, r);
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body, { ok: true, recorded: true });
  assert.deepStrictEqual(calls.record[0], { alanyaID: 7, appareilId: 3, hevcDecode: true });

  for (const body of [{}, { hevcDecode: 'oui' }, { hevcDecode: 1 }, null]) {
    r = res();
    await putVideoCapabilities({ user, body }, r);
    assert.strictEqual(r.code, 400, `refusé : ${JSON.stringify(body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION_FAILED');
  }
  assert.strictEqual(calls.record.length, 1, 'rien enregistré sur une demande mal formée');

  console.log('videoCodecsController.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
