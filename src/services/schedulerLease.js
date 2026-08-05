const crypto = require('crypto');
const pool = require('../config/db');

const WORKER_ID = `${process.env.HOSTNAME || 'local'}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 * @param {number} [ttlSeconds=55]
 */
async function withLease(name, fn, ttlSeconds = 55) {
  const acquired = await tryAcquire(name, ttlSeconds);
  if (!acquired) return;
  try {
    await fn();
  } finally {
    await release(name);
  }
}

async function tryAcquire(name, ttlSeconds = 55) {
  const [res] = await pool.execute(
    `UPDATE scheduler_leases
     SET locked_by = ?, locked_until = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE name = ?
       AND (locked_until IS NULL OR locked_until < NOW())`,
    [WORKER_ID, ttlSeconds, name],
  );
  return res.affectedRows === 1;
}

async function release(name) {
  await pool.execute(
    `UPDATE scheduler_leases
     SET locked_by = NULL, locked_until = NULL
     WHERE name = ? AND locked_by = ?`,
    [name, WORKER_ID],
  );
}

module.exports = { withLease, tryAcquire, release, WORKER_ID };
