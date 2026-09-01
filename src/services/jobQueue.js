const crypto = require('crypto');
const pool = require('../config/db');
const { WORKER_ID } = require('./schedulerLease');

const BATCH_SIZE = 20;
const ORPHAN_MS = 10 * 60 * 1000;

/** @type {Map<string, (payload: object) => Promise<void>>} */
const handlers = new Map();

let workerTimer = null;
let running = false;

function registerJobHandler(kind, fn) {
  handlers.set(kind, fn);
}

/**
 * Met un job en file.
 *
 * `reviveFailed` relance un job de même clé qui avait échoué définitivement.
 * Sans lui, la ligne en échec reste en base avec sa clé de déduplication, et
 * toute remise en file suivante retombe dessus via `ON DUPLICATE KEY` : le job
 * ne repart plus jamais. Acceptable pour un enchaînement automatique, mais pas
 * pour une action déclenchée à la main, qui doit pouvoir réessayer.
 *
 * Retourne l'identifiant du job mis en file, ou `null` si un job identique
 * était déjà en attente. Les appelants doivent tester ce retour avant
 * d'annoncer un lancement.
 */
async function enqueue(
  kind,
  payload,
  { dedupeKey = null, runAfter = null, maxAttempts = 5, reviveFailed = false } = {},
) {
  const runAfterVal = runAfter instanceof Date ? runAfter : runAfter ? new Date(runAfter) : new Date();

  if (reviveFailed && dedupeKey) {
    await pool.execute(
      'DELETE FROM job_queue WHERE kind = ? AND dedupe_key = ? AND failed_at IS NOT NULL',
      [kind, dedupeKey],
    );
  }

  const [res] = await pool.execute(
    `INSERT INTO job_queue (kind, payload, dedupe_key, run_after, max_attempts)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [kind, JSON.stringify(payload || {}), dedupeKey, runAfterVal, maxAttempts],
  );
  return res.insertId || null;
}

/**
 * Désarme tous les jobs en attente pour une clé de déduplication + une liste
 * de kinds. Indispensable avant tout ré-armement : `enqueue` fait
 * `ON DUPLICATE KEY UPDATE id = id` et renvoie `null` en silence si la clé
 * existe déjà — sans désarmer d'abord, un ré-armement paraîtrait fonctionner
 * mais l'ancienne échéance resterait celle qui compte.
 */
async function cancelByDedupeKey(dedupeKey, kinds) {
  if (!dedupeKey || !kinds?.length) return;
  await pool.execute(
    `DELETE FROM job_queue WHERE dedupe_key = ? AND kind IN (${kinds.map(() => '?').join(',')})`,
    [dedupeKey, ...kinds],
  );
}

/**
 * Un job de ce kind/dedupeKey est-il actuellement en attente (armé) ?
 *
 * `failed_at IS NULL` n'est pas un détail : une ligne définitivement en échec
 * garde sa clé de déduplication, et sans ce filtre elle passait pour une grâce
 * encore armée. `callState` s'en sert pour décider si un `in_call` tient
 * toujours — un compte restait donc « occupé », incapable de passer ou de
 * recevoir un appel, jusqu'à la purge de la ligne morte.
 */
async function hasJob(dedupeKey, kind) {
  if (!dedupeKey) return false;
  const [rows] = await pool.execute(
    'SELECT 1 FROM job_queue WHERE dedupe_key = ? AND kind = ? AND failed_at IS NULL LIMIT 1',
    [dedupeKey, kind],
  );
  return rows.length > 0;
}

async function reclaimOrphans() {
  await pool.execute(
    `UPDATE job_queue
     SET locked_at = NULL, locked_by = NULL
     WHERE locked_at IS NOT NULL
       AND failed_at IS NULL
       AND locked_at < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [Math.floor(ORPHAN_MS / 1000)],
  );
}

function backoffSeconds(attempts) {
  const base = Math.min(300, Math.pow(2, attempts) * 5);
  const jitter = Math.floor(Math.random() * 5);
  return base + jitter;
}

async function processOneJob(conn) {
  // Ne verrouiller que les types que CETTE instance sait exécuter.
  //
  // La file est partagée par toutes les instances qui pointent sur la même
  // base. Sans ce filtre, une instance restée sur une version antérieure du
  // code (déploiement progressif, serveur oublié) verrouille un job d'un
  // type qu'elle ne connaît pas, échoue, et le job s'épuise en tentatives
  // alors qu'une autre instance savait parfaitement le traiter — un délai
  // d'appel ou une échéance de trajet partirait en retard, ou pas du tout.
  // Ici, elle ne le voit tout simplement pas, et il reste disponible pour
  // qui sait s'en occuper.
  const kinds = [...handlers.keys()];
  if (kinds.length === 0) return false;

  await conn.beginTransaction();
  const [rows] = await conn.execute(
    `SELECT id, kind, payload, attempts, max_attempts
     FROM job_queue
     WHERE failed_at IS NULL
       AND locked_at IS NULL
       AND run_after <= NOW()
       AND kind IN (${kinds.map(() => '?').join(',')})
     ORDER BY run_after ASC, id ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    kinds,
  );
  if (!rows.length) {
    await conn.commit();
    return false;
  }
  const job = rows[0];
  await conn.execute(
    `UPDATE job_queue SET locked_at = NOW(), locked_by = ? WHERE id = ?`,
    [WORKER_ID, job.id],
  );
  await conn.commit();

  const handler = handlers.get(job.kind);
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

  try {
    // Invariant : le SELECT ci-dessus filtre déjà sur les kinds connus. Un
    // handler manquant ici signalerait un désenregistrement en cours de route.
    if (!handler) throw new Error(`Handler inconnu: ${job.kind}`);
    await handler(payload, job);
    await pool.execute('DELETE FROM job_queue WHERE id = ?', [job.id]);
  } catch (err) {
    const attempts = job.attempts + 1;
    const terminal = attempts >= job.max_attempts;
    if (terminal) {
      await pool.execute(
        `UPDATE job_queue
         SET attempts = ?, failed_at = NOW(), last_error = ?, locked_at = NULL, locked_by = NULL
         WHERE id = ?`,
        [attempts, String(err.message || err).slice(0, 2000), job.id],
      );
      if (job.kind === 'broadcast_push' && payload?.broadcastId) {
        const { markPushJobFailed } = require('./broadcastService');
        await markPushJobFailed(payload.broadcastId).catch(() => {});
      }
    } else {
      const delay = backoffSeconds(attempts);
      await pool.execute(
        `UPDATE job_queue
         SET attempts = ?, run_after = DATE_ADD(NOW(), INTERVAL ? SECOND),
             last_error = ?, locked_at = NULL, locked_by = NULL
         WHERE id = ?`,
        [attempts, delay, String(err.message || err).slice(0, 2000), job.id],
      );
    }
  }
  return true;
}

/**
 * Le worker est-il actif ?
 *
 * Historiquement `BROADCAST_WORKER_ENABLED` : la file ne servait qu'aux
 * diffusions. Elle porte désormais les échéances des trajets de confiance, où
 * l'enjeu n'est plus le même — sans worker, aucune alerte ne partirait jamais,
 * et on promettrait un filet qui n'existe pas.
 *
 * `JOB_WORKER_ENABLED` est le nom qui convient ; l'ancien reste accepté pour ne
 * pas casser les déploiements en place.
 */
function isJobWorkerEnabled() {
  const v = process.env.JOB_WORKER_ENABLED ?? process.env.BROADCAST_WORKER_ENABLED;
  return v === 'true' || v === '1';
}

async function tickWorker() {
  if (running) return;
  if (!isJobWorkerEnabled()) return;
  running = true;
  try {
    await reclaimOrphans();
    const conn = await pool.getConnection();
    try {
      for (let i = 0; i < BATCH_SIZE; i++) {
        const had = await processOneJob(conn);
        if (!had) break;
      }
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[JobQueue] tick:', e.message);
  } finally {
    running = false;
  }
}

function startJobWorker() {
  if (!isJobWorkerEnabled()) {
    console.warn(
      '[JobQueue] Worker DÉSACTIVÉ (JOB_WORKER_ENABLED != true) — '
      + 'les échéances de trajet ne se déclencheront pas.',
    );
    return;
  }
  console.log('[JobQueue] Worker démarré');
  workerTimer = setInterval(() => tickWorker().catch(() => {}), 1000);
  tickWorker().catch(() => {});
}

function stopJobWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

module.exports = {
  enqueue,
  cancelByDedupeKey,
  hasJob,
  isJobWorkerEnabled,
  registerJobHandler,
  startJobWorker,
  stopJobWorker,
  reclaimOrphans,
  processOneJob,
};
