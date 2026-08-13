const { registerJobHandler } = require('./jobQueue');
const {
  processWelcomeBackfillBatch,
  continueBackfillChain,
} = require('./welcomeService');

function registerWelcomeJobHandlers() {
  registerJobHandler('welcome_backfill', async (payload) => {
    const result = await processWelcomeBackfillBatch({
      idFrom: Number(payload.idFrom) || 0,
    });
    await continueBackfillChain(result.lastId, result.hasMore);
  });
}

module.exports = { registerWelcomeJobHandlers };
