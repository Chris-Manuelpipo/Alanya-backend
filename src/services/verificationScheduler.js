const pool = require('../config/db');
const { ACCOUNT_TYPE, VERIFICATION } = require('../constants/accountTypes');
const { withLease } = require('./schedulerLease');
const {
  publishBroadcast,
  findBroadcastByClientId,
  estimateAudience,
} = require('./broadcastService');

let interval = null;

async function runVerificationTick() {
  await withLease('verification_scheduler', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const clientId = `verification-reminder:${today}`;

    const existing = await findBroadcastByClientId(clientId);
    if (existing) return;

    const [official] = await pool.execute(
      'SELECT alanyaID FROM users WHERE account_type = ? ORDER BY alanyaID ASC LIMIT 1',
      [ACCOUNT_TYPE.OFFICIEL],
    );
    if (!official.length) return;

    const criteria = {
      v: 1,
      op: 'and',
      conditions: [
        { field: 'account_type', op: 'eq', value: ACCOUNT_TYPE.BUSINESS },
        { field: 'verification_status', op: 'eq', value: VERIFICATION.VERIFIE },
        {
          field: 'verified_until',
          op: 'before',
          value: { absolute: new Date(Date.now() + 30 * 86400000).toISOString() },
        },
      ],
    };

    const [candidates] = await pool.execute(
      `SELECT alanyaID FROM users
       WHERE account_type = ?
         AND verification_status = ?
         AND verified_until IS NOT NULL
         AND verified_until <= DATE_ADD(NOW(), INTERVAL 30 DAY)
         AND verified_until > NOW()
         AND verification_reminder_sent = 0
       LIMIT 1`,
      [ACCOUNT_TYPE.BUSINESS, VERIFICATION.VERIFIE],
    );
    if (!candidates.length) return;

    const { count } = await estimateAudience(criteria);
    await publishBroadcast({
      senderId: official[0].alanyaID,
      createdBy: official[0].alanyaID,
      kind: 0,
      content: 'Votre vérification business expire bientôt. Renouvelez-la depuis Mon compte.',
      type: 0,
      mediaUrl: null,
      criteria,
      clientId,
      estimate: count,
    });

    await pool.execute(
      `UPDATE users SET verification_reminder_sent = 1
       WHERE account_type = ?
         AND verification_status = ?
         AND verified_until IS NOT NULL
         AND verified_until <= DATE_ADD(NOW(), INTERVAL 30 DAY)
         AND verified_until > NOW()
         AND verification_reminder_sent = 0`,
      [ACCOUNT_TYPE.BUSINESS, VERIFICATION.VERIFIE],
    );
  });
}

function startVerificationScheduler() {
  interval = setInterval(() => {
    runVerificationTick().catch((e) => console.error('[VerificationScheduler]', e.message));
  }, 60 * 60 * 1000);
  runVerificationTick().catch(() => {});
}

function stopVerificationScheduler() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

module.exports = { startVerificationScheduler, stopVerificationScheduler, runVerificationTick };
