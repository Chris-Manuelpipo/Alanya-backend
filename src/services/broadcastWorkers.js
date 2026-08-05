const { registerJobHandler } = require('./jobQueue');
const {
  prepareBroadcast,
  sendBroadcastPushBatch,
  publishBroadcast,
} = require('./broadcastService');

function registerBroadcastJobHandlers() {
  registerJobHandler('broadcast_prepare', async (payload) => {
    await prepareBroadcast(payload.broadcastId);
  });

  registerJobHandler('broadcast_push', async (payload) => {
    await sendBroadcastPushBatch(payload);
  });

  registerJobHandler('broadcast_send', async (payload) => {
    await publishBroadcast(payload);
  });
}

module.exports = { registerBroadcastJobHandlers };
