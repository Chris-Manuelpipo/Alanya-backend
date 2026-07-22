const assert = require('assert');
const { hashForLog, previewForLog, logNotificationEvent } = require('./notificationLogger');

const run = () => {
  assert.strictEqual(hashForLog('abc').length, 12);
  assert.notStrictEqual(hashForLog('token-a'), hashForLog('token-b'));

  assert.strictEqual(previewForLog('short'), 'short');
  const long = 'a'.repeat(50);
  assert.ok(previewForLog(long).endsWith('...'));

  // Capture console
  const lines = [];
  const orig = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    logNotificationEvent('notification_sent', {
      eventId: 'e1',
      type: 'message',
      msgID: '12',
      conversationId: '3',
      fcmToken: 'secret-token-value',
      body: 'Message très long qui ne doit pas apparaître en entier dans les logs',
      durationMs: 42,
    });
  } finally {
    console.log = orig;
  }

  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0].replace('[NotifTrace] ', ''));
  assert.strictEqual(parsed.event, 'notification_sent');
  assert.strictEqual(parsed.eventId, 'e1');
  assert.ok(parsed.fcmToken);
  assert.ok(!parsed.fcmToken.includes('secret-token-value'));
  assert.ok(parsed.bodyPreview);
  assert.ok(!parsed.body);

  console.log('notificationLogger.test.js: OK');
};

run();
