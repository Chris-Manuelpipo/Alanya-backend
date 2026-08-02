const pool = require('../config/db');
const fs = require('fs/promises');
const path = require('path');

const GRACE_DAYS = 7;
const EXPORT_DIR = path.join(__dirname, '../../uploads/exports');
const SELF_DELETE_REASON = 'self_delete_pending';

const _isPendingSelfDelete = (row) =>
  row.exclus === 1
  && row.exclude_reason === SELF_DELETE_REASON
  && row.delete_scheduled_at
  && new Date(row.delete_scheduled_at).getTime() > Date.now();

const isPendingSelfDeleteRow = _isPendingSelfDelete;

const scheduleAccountDeletion = async (alanyaID) => {
  const scheduledAt = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  await pool.execute(
    `UPDATE users
        SET exclus = 1,
            exclude_reason = ?,
            delete_requested_at = NOW(),
            delete_scheduled_at = ?
      WHERE alanyaID = ? AND exclus = 0`,
    [SELF_DELETE_REASON, scheduledAt, alanyaID],
  );
  return scheduledAt;
};

const cancelAccountDeletion = async (alanyaID) => {
  const [rows] = await pool.execute(
    `SELECT alanyaID, exclus, exclude_reason, delete_scheduled_at
       FROM users WHERE alanyaID = ?`,
    [alanyaID],
  );
  if (rows.length === 0) return false;
  const row = rows[0];
  if (!_isPendingSelfDelete(row)) return false;

  await pool.execute(
    `UPDATE users
        SET exclus = 0,
            exclude_reason = NULL,
            delete_requested_at = NULL,
            delete_scheduled_at = NULL
      WHERE alanyaID = ?`,
    [alanyaID],
  );
  return true;
};

const purgeExpiredAccounts = async () => {
  const [rows] = await pool.execute(
    `SELECT alanyaID FROM users
      WHERE delete_scheduled_at IS NOT NULL
        AND delete_scheduled_at <= NOW()
        AND exclude_reason = ?`,
    [SELF_DELETE_REASON],
  );

  for (const row of rows) {
    try {
      await _purgeUser(Number(row.alanyaID));
    } catch (e) {
      console.error('[AccountDeletion] purge failed:', row.alanyaID, e.message);
    }
  }
  return rows.length;
};

const _purgeUser = async (alanyaID) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      'DELETE FROM blocked WHERE alanyaID = ? OR idCallerBlock = ?',
      [alanyaID, alanyaID],
    );

    const [jobs] = await conn.execute(
      'SELECT filePath FROM user_export_jobs WHERE alanyaID = ?',
      [alanyaID],
    );
    for (const job of jobs) {
      if (!job.filePath) continue;
      try {
        await fs.unlink(path.join(EXPORT_DIR, path.basename(job.filePath)));
      } catch (_) {}
    }

    await conn.execute(
      `UPDATE message SET senderID = NULL WHERE senderID = ?`,
      [alanyaID],
    );

    await conn.execute('DELETE FROM users WHERE alanyaID = ?', [alanyaID]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

const startDeletionPurgeScheduler = () => {
  const tick = () => {
    purgeExpiredAccounts().catch((e) =>
      console.error('[AccountDeletion] scheduler error:', e.message),
    );
  };
  tick();
  return setInterval(tick, 60 * 60 * 1000);
};

module.exports = {
  GRACE_DAYS,
  SELF_DELETE_REASON,
  isPendingSelfDeleteRow,
  scheduleAccountDeletion,
  cancelAccountDeletion,
  purgeExpiredAccounts,
  startDeletionPurgeScheduler,
};
