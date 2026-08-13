const assert = require('assert');

function backoffSeconds(attempts) {
  const base = Math.min(300, Math.pow(2, attempts) * 5);
  return base;
}

assert.ok(backoffSeconds(1) >= 10);
assert.ok(backoffSeconds(3) >= 40);
assert.ok(backoffSeconds(10) <= 300);

console.log('jobQueue.test.js OK');
