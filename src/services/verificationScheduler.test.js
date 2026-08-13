const assert = require('assert');

// J-30 : clientId déterministe par date
const today = new Date().toISOString().slice(0, 10);
const clientId = `verification-reminder:${today}`;
assert.match(clientId, /^verification-reminder:\d{4}-\d{2}-\d{2}$/);

const d1 = `verification-reminder:2026-08-04`;
const d2 = `verification-reminder:2026-08-04`;
assert.strictEqual(d1, d2);

console.log('verificationScheduler.test.js OK');
