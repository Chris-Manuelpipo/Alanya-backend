/**
 * Pose des jobs d'échéance. Aucune décision ici : chaque job relit l'état au
 * moment de s'exécuter (billingJobs.js), si bien qu'un job devenu inutile se
 * contente de ne rien faire. La clé de dédoublonnage porte l'instant visé :
 * reposer les mêmes jobs est sans effet, en poser pour une nouvelle fin ne
 * dérange pas les anciens.
 */

const { enqueue } = require('../jobQueue');
const { DAY_MS, PURGE_WARNING_DAYS, dueSchedule } = require('./rules');

const iso = (v) => (v ? new Date(v).toISOString() : null);
const key = (kind, alanyaID, at) => `${kind}:${alanyaID}:${new Date(at).getTime()}`;

/** Relance, renouvellement automatique et expiration d'une fin de chaîne. */
async function scheduleChainJobs(alanyaID, end, reminderDays, now = new Date()) {
  const endIso = iso(end);
  for (const job of dueSchedule({ end, reminderDays, now })) {
    await enqueue(job.kind, { alanyaID, end: endIso }, {
      dedupeKey: key(job.kind, alanyaID, end),
      runAfter: job.at,
    });
  }
}

/** Dernier avertissement (J−7) et purge d'un compte échu. */
async function schedulePurgeJobs(alanyaID, purgeAfter, now = new Date()) {
  const at = new Date(purgeAfter);
  const warnAt = new Date(at.getTime() - PURGE_WARNING_DAYS * DAY_MS);
  if (warnAt > now) {
    await enqueue('billing_purge_warning', { alanyaID, purgeAfter: iso(at) }, {
      dedupeKey: key('billing_purge_warning', alanyaID, at),
      runAfter: warnAt,
    });
  }
  await enqueue('billing_purge', { alanyaID, purgeAfter: iso(at) }, {
    dedupeKey: key('billing_purge', alanyaID, at),
    runAfter: at,
  });
}

/** Rappel collectif à J−7 de la fin de grâce, puis la fin de grâce elle-même. */
async function scheduleGraceJobs(graceUntil, now = new Date()) {
  if (!graceUntil) return;
  const at = new Date(graceUntil);
  const g = iso(at);
  const remindAt = new Date(at.getTime() - 7 * DAY_MS);
  if (remindAt > now) {
    await enqueue('billing_grace_reminder', { graceUntil: g }, {
      dedupeKey: `billing_grace_reminder:${at.getTime()}`,
      runAfter: remindAt,
    });
  }
  await enqueue('billing_grace_end', { graceUntil: g }, {
    dedupeKey: `billing_grace_end:${at.getTime()}`,
    runAfter: at,
  });
}

/**
 * Après une activation : l'annonce, la compensation des abonnés si l'on
 * revient d'une phase gratuite (deactivated_at posé), et les jobs de grâce.
 *
 * @param {object} settings  ligne billing_settings après activation
 */
async function scheduleActivation(settings, now = new Date()) {
  const activatedAt = iso(settings.activated_at);
  if (!activatedAt) return;
  const at = new Date(activatedAt).getTime();
  await enqueue('billing_announce', { activatedAt, graceUntil: iso(settings.grace_until) }, {
    dedupeKey: `billing_announce:${at}`,
  });
  if (settings.deactivated_at) {
    await enqueue('billing_compensate', { activatedAt, deactivatedAt: iso(settings.deactivated_at) }, {
      dedupeKey: `billing_compensate:${at}`,
    });
  }
  await scheduleGraceJobs(settings.grace_until, now);
}

module.exports = {
  scheduleChainJobs,
  schedulePurgeJobs,
  scheduleGraceJobs,
  scheduleActivation,
};
