const assert = require('assert');

const buildApsSound = (data) => {
  if (data.soundEnabled === '0') return undefined;
  return 'default';
};

assert.strictEqual(buildApsSound({ soundEnabled: '1' }), 'default');
assert.strictEqual(buildApsSound({ soundEnabled: '0' }), undefined);

console.log('notificationApns.test.js OK');
