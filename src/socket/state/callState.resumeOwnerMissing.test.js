// Timer owner-missing + confirmResume annule les timers de reprise.
const assert = require('assert');
const callState = require('./callState');

function reset() {
  [10, 77].forEach((id) => callState.clear(id));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1) scheduleResumeOwnerMissing s'arme sans socket owner.
  reset();
  callState.setInCall(10, { callId: '900', peerId: 77 });
  let fired = 0;
  callState.scheduleResumeOwnerMissing(10, () => {
    fired += 1;
  }, 30);
  assert.ok(callState.getEntry(10)?.resumeOwnerMissingTimer, 'timer armé');
  // Double schedule : ne réarme pas.
  callState.scheduleResumeOwnerMissing(10, () => {
    fired += 10;
  }, 30);
  await wait(80);
  assert.strictEqual(fired, 1, 'un seul fire');

  // 2) confirmResume annule owner-missing + ack + disconnect grace.
  reset();
  callState.setInCall(10, { callId: '901', peerId: 77 });
  let expired = 0;
  callState.scheduleDisconnectGrace(10, () => { expired += 1; });
  callState.scheduleResumeAck(10, () => { expired += 1; }, 5000);
  callState.scheduleResumeOwnerMissing(10, () => { expired += 1; }, 5000);
  callState.confirmResume(10);
  assert.strictEqual(callState.getEntry(10)?.disconnectTimer, null);
  assert.strictEqual(callState.getEntry(10)?.resumeAckTimer, null);
  assert.strictEqual(callState.getEntry(10)?.resumeOwnerMissingTimer, null);
  await wait(50);
  assert.strictEqual(expired, 0, 'aucun timer après confirmResume');

  // 3) Constantes exportées.
  assert.ok(callState.RESUME_OWNER_MISSING_TIMEOUT_MS >= 8000);
  assert.ok(callState.RESUME_ACK_MS >= 1000);

  reset();
  console.log('callState.resumeOwnerMissing.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
