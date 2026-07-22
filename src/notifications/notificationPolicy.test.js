const assert = require('assert');
const {
  getMessagePushOptions,
  getCallPushOptions,
} = require('./notificationPolicy');

const run = () => {
  const msgOpts = getMessagePushOptions();
  assert.strictEqual(msgOpts.skipIfDeviceOnline, undefined);
  assert.strictEqual(msgOpts.io, undefined);

  const callOpts = getCallPushOptions();
  assert.strictEqual(callOpts.skipIfDeviceOnline, undefined);

  console.log('notificationPolicy.test.js: OK');
};

run();
