/**
 * Jobs d'échéance de l'abonnement (volet 8, « Des jobs posés à la bonne
 * heure ») : relance, renouvellement automatique, expiration, dernier
 * avertissement, purge — et, côté interrupteur, annonce, compensation, rappel
 * et fin de grâce.
 *
 * Chaque handler relit l'état et consulte une règle pure de rules.js ; les
 * écritures sont conditionnelles (`… AND purge_after IS NULL`), si bien qu'un
 * job rejoué, ou doublé par le balayage de rattrapage, ne fait rien deux fois.
 */

const pool = require('../../config/db');
const { registerJobHandler } = require('../jobQueue');
const {
  publishBroadcast, findBroadcastByClientId, estimateAudience,
} = require('../broadcastService');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { PERIOD_SOURCE } = require('../../constants/billing');
const { getBillingSettings } = require('./settings');
const {
  DAY_MS, sameInstant, effectivePhase, reminderApplies, autoRenewApplies,
  expiryDecision, purgeDecision, purgeWarningApplies, compensationDays,
} = require('./rules');
const {
  notifyEntitlementsChanged, emitToEveryone, grantPeriod,
} = require('./subscriptions');
const { schedulePurgeJobs } = require('./billingSchedule');
const { purgeFeatureData } = require('./featurePurge');
const { recomputeAllVerifications } = require('./verification');
const { pushBilling, messages, fmtDay } = require('./billingNotify');

const readSubscriber = async (alanyaID) => {
  const [[sub]] = await pool.execute('SELECT * FROM subscriber WHERE alanyaID = ?', [alanyaID]);
  return sub || null;
};

const daysUntil = (d, now) => Math.max(0, Math.ceil((new Date(d).getTime() - now.getTime()) / DAY_MS));

// ── Par compte ──────────────────────────────────────────────────────────

async function handleReminder({ alanyaID, end }, now = new Date()) {
  const [settings, sub] = await Promise.all([getBillingSettings(), readSubscriber(alanyaID)]);
  const phase = effectivePhase(settings, alanyaID, now);
  if (!sub || !reminderApplies({ phase, currentEnd: sub.current_end, jobEnd: end, now })) return;
  await pushBilling(alanyaID, messages.reminder({
    daysLeft: daysUntil(sub.current_end, now),
    autoRenew: Number(sub.auto_renew) === 1,
  }));
}

async function handleAutoRenew({ alanyaID, end }, now = new Date()) {
  const [settings, sub] = await Promise.all([getBillingSettings(), readSubscriber(alanyaID)]);
  const phase = effectivePhase(settings, alanyaID, now);
  // Phase gratuite : les renouvellements automatiques sont suspendus.
  if (!autoRenewApplies({ phase, sub, jobEnd: end, now })) return;
  // Requis à l'appel : paymentService requiert ce module par billingSchedule.
  const { initiateRenewal } = require('../payments/paymentService');
  const started = await initiateRenewal({ alanyaID, now });
  if (started) {
    await pushBilling(alanyaID, messages.renewalRequested({
      brand: started.channel === 'mtn_momo' ? 'MTN Mobile Money' : 'Orange Money',
      amount: Number(started.amount).toLocaleString('fr-FR'),
    }));
  }
}

async function handleExpire({ alanyaID }, now = new Date()) {
  const [settings, sub] = await Promise.all([getBillingSettings(), readSubscriber(alanyaID)]);
  const decision = expiryDecision({
    phase: effectivePhase(settings, alanyaID, now),
    sub,
    now,
    retentionDays: Number(settings.retention_days),
  });
  if (decision.action !== 'expire') return;

  // Conditionnelle : le job et le balayage peuvent se croiser, un seul
  // l'emporte — et c'est lui seul qui notifie.
  const [res] = await pool.execute(
    `UPDATE subscriber SET purge_after = ?
      WHERE alanyaID = ? AND purge_after IS NULL AND purged_at IS NULL AND current_end <= ?`,
    [decision.purgeAfter, alanyaID, now],
  );
  if (res.affectedRows !== 1) return;

  notifyEntitlementsChanged(alanyaID);
  await schedulePurgeJobs(alanyaID, decision.purgeAfter, now);
  if (decision.notify) await pushBilling(alanyaID, messages.expired({ purgeAfter: decision.purgeAfter }));
}

async function handlePurgeWarning({ alanyaID, purgeAfter }, now = new Date()) {
  const [settings, sub] = await Promise.all([getBillingSettings(), readSubscriber(alanyaID)]);
  const phase = effectivePhase(settings, alanyaID, now);
  if (!purgeWarningApplies({ phase, sub, jobPurgeAfter: purgeAfter, now })) return;
  await pushBilling(alanyaID, messages.purgeWarning({ purgeAfter: sub.purge_after }));
}

async function handlePurge({ alanyaID }, now = new Date()) {
  const [settings, sub] = await Promise.all([getBillingSettings(), readSubscriber(alanyaID)]);
  const decision = purgeDecision({
    phase: effectivePhase(settings, alanyaID, now),
    sub,
    now,
    retentionDays: Number(settings.retention_days),
  });

  if (decision.action === 'postpone') {
    const [res] = await pool.execute(
      'UPDATE subscriber SET purge_after = ? WHERE alanyaID = ? AND purged_at IS NULL AND purge_after <= ?',
      [decision.purgeAfter, alanyaID, now],
    );
    if (res.affectedRows === 1) {
      notifyEntitlementsChanged(alanyaID);
      await schedulePurgeJobs(alanyaID, decision.purgeAfter, now);
    }
    return;
  }
  if (decision.action !== 'purge') return;

  // Le marqueur d'abord, conditionnel : deux exécutions concurrentes n'en
  // laissent passer qu'une.
  const [res] = await pool.execute(
    'UPDATE subscriber SET purged_at = ? WHERE alanyaID = ? AND purged_at IS NULL AND purge_after <= ?',
    [now, alanyaID, now],
  );
  if (res.affectedRows !== 1) return;
  const done = await purgeFeatureData(alanyaID);
  console.log(`[billing] purge du compte ${alanyaID} : ${done.trips} trajet(s), ${done.lists} liste(s)`);
  notifyEntitlementsChanged(alanyaID);
}

// ── Interrupteur ────────────────────────────────────────────────────────

const EVERYONE = Object.freeze({ v: 1, op: 'and', conditions: [] });

async function officialSenderId() {
  const [[row]] = await pool.execute(
    'SELECT alanyaID FROM users WHERE account_type = ? ORDER BY alanyaID ASC LIMIT 1',
    [ACCOUNT_TYPE.OFFICIEL],
  );
  return row?.alanyaID ?? null;
}

/** Diffusion du compte officiel à tous, idempotente par `clientId`. */
async function broadcastToEveryone(clientId, translations) {
  if (await findBroadcastByClientId(clientId)) return false;
  const sender = await officialSenderId();
  if (!sender) {
    console.warn(`[billing] ${clientId} : aucun compte officiel pour diffuser`);
    return false;
  }
  const { count } = await estimateAudience(EVERYONE);
  await publishBroadcast({
    senderId: sender,
    createdBy: sender,
    kind: 0,
    type: 0,
    translations,
    criteria: EVERYONE,
    clientId,
    estimate: count,
  });
  return true;
}

const graceText = (graceUntil) => ({
  fr: `Alanya Plus arrive. Jusqu'au ${fmtDay(graceUntil)}, traduction, sauvegarde, trajets de confiance et sonneries par liste restent gratuits. Ensuite, ils rejoignent l'offre annuelle à 1 000 F, qui inclut aussi la coche « Abonné Alanya Plus ». Abonnez-vous dès maintenant depuis votre profil : votre première période et votre coche commencent à cette date.`,
  en: `Alanya Plus is coming. Until ${fmtDay(graceUntil, 'en-GB')}, translation, backup, trusted trips and list ringtones stay free. Then they join the yearly offer at 1,000 F, which also includes the “Alanya Plus subscriber” badge. Subscribe now from your profile: your first period and badge start on that date.`,
  zh: `Alanya Plus 即将推出。在 ${fmtDay(graceUntil, 'zh-CN')} 之前，翻译、备份、可信行程和列表铃声仍然免费。之后它们将纳入每年 1,000 F 的方案，并附带「Alanya Plus 订阅用户」标记。现在即可在个人资料中订阅：您的第一个周期和标记将从该日期开始。`,
});

const graceReminderText = (graceUntil) => ({
  fr: `Plus que 7 jours : à partir du ${fmtDay(graceUntil)}, traduction, sauvegarde, trajets et sonneries par liste font partie d'Alanya Plus (1 000 F / an, avec la coche). Déjà abonné ? Rien à faire.`,
  en: `7 days left: from ${fmtDay(graceUntil, 'en-GB')}, translation, backup, trips and list ringtones will be part of Alanya Plus (1,000 F / year, with the badge). Already subscribed? Nothing to do.`,
  zh: `还剩 7 天：自 ${fmtDay(graceUntil, 'zh-CN')} 起，翻译、备份、行程和列表铃声将属于 Alanya Plus（每年 1,000 F，含标记）。已经订阅？无需任何操作。`,
});

/** L'activation tient toujours (pas désactivée ni rejouée entre-temps). */
const stillActivated = (s, activatedAt) =>
  Number(s.paid_enabled) === 1 && sameInstant(s.activated_at, activatedAt);

async function handleAnnounce({ activatedAt, graceUntil }) {
  const s = await getBillingSettings();
  if (!stillActivated(s, activatedAt) || !s.grace_until) return;
  await broadcastToEveryone(
    `billing-activation:${new Date(activatedAt).getTime()}`,
    graceText(s.grace_until ?? graceUntil),
  );
}

async function handleGraceReminder({ graceUntil }, now = new Date()) {
  const s = await getBillingSettings();
  if (Number(s.paid_enabled) !== 1 || !sameInstant(s.grace_until, graceUntil)) return;
  if (new Date(graceUntil) <= now) return;
  await broadcastToEveryone(
    `billing-grace-reminder:${new Date(graceUntil).getTime()}`,
    graceReminderText(graceUntil),
  );
}

/**
 * Fin de grâce : les fonctionnalités se ferment pour les non-abonnés. Les
 * téléphones connectés relisent leurs droits tout de suite ; les autres le
 * feront à leur retour (`validUntil` ne dépasse jamais la fin de grâce).
 */
async function handleGraceEnd({ graceUntil }) {
  const s = await getBillingSettings();
  if (Number(s.paid_enabled) !== 1 || !sameInstant(s.grace_until, graceUntil)) return;
  // Les coches des non-abonnés tombent maintenant : recalcul par lots, puis
  // signal aux téléphones connectés.
  await recomputeAllVerifications();
  emitToEveryone('entitlements:updated', { at: new Date().toISOString() });
}

/** Transitions de l'interrupteur : la phase change, l'échéance des coches aussi. */
async function handleRecomputeVerifications() {
  await recomputeAllVerifications();
}

/**
 * Retour au payant après une phase gratuite : les comptes dont une période
 * couvrait la désactivation reçoivent une période de compensation égale à
 * la durée de la phase gratuite. Idempotente par compte (motif daté).
 */
async function handleCompensate({ activatedAt, deactivatedAt }, now = new Date()) {
  const s = await getBillingSettings();
  if (!stillActivated(s, activatedAt)) return;
  const days = compensationDays({ deactivatedAt, activatedAt });
  if (!days) return;

  const reason = `compensation:${new Date(activatedAt).toISOString()}`;
  const [rows] = await pool.execute(
    `SELECT sp.alanyaID, MAX(sp.plan_id) AS plan_id,
            MAX(sp.grants_badge) AS grants_badge
       FROM subscription_period sp
      WHERE sp.starts_at <= ? AND sp.ends_at > ?
      GROUP BY sp.alanyaID`,
    [new Date(deactivatedAt), new Date(deactivatedAt)],
  );
  let granted = 0;
  for (const row of rows) {
    const [[already]] = await pool.execute(
      'SELECT id FROM subscription_period WHERE alanyaID = ? AND source = ? AND reason = ? LIMIT 1',
      [row.alanyaID, PERIOD_SOURCE.COMPENSATION, reason],
    );
    if (already) continue;
    const [[plan]] = await pool.execute('SELECT * FROM plan WHERE id = ?', [row.plan_id]);
    if (!plan) continue;
    await grantPeriod({
      alanyaID: row.alanyaID, plan, now, source: PERIOD_SOURCE.COMPENSATION, reason, days,
      // Hérite de la période couvrant la désactivation : qui avait la coche
      // la retrouve, qui ne l'avait pas ne la gagne pas au passage.
      grantsBadge: Number(row.grants_badge) === 1,
    });
    granted++;
  }
  if (granted) console.log(`[billing] compensation : ${granted} compte(s), ${days} jour(s)`);
}

// ── Rattrapage ──────────────────────────────────────────────────────────

/**
 * Filet des jobs perdus (redéploiement, file purgée) : les échéances passées
 * sans expiration enregistrée, les purges échues. Les handlers étant
 * conditionnels, croiser un job en cours est sans conséquence.
 */
async function catchUpDue(now = new Date()) {
  const [expired] = await pool.execute(
    `SELECT alanyaID FROM subscriber
      WHERE current_end IS NOT NULL AND current_end <= ?
        AND purge_after IS NULL AND purged_at IS NULL
      LIMIT 500`,
    [now],
  );
  for (const r of expired) {
    try { await handleExpire({ alanyaID: r.alanyaID }, now); } catch (err) {
      console.error(`[billing] rattrapage de l'échéance ${r.alanyaID} :`, err.message);
    }
  }
  const [due] = await pool.execute(
    `SELECT alanyaID FROM subscriber
      WHERE purge_after IS NOT NULL AND purge_after <= ? AND purged_at IS NULL
      LIMIT 200`,
    [now],
  );
  for (const r of due) {
    try { await handlePurge({ alanyaID: r.alanyaID }, now); } catch (err) {
      console.error(`[billing] rattrapage de la purge ${r.alanyaID} :`, err.message);
    }
  }
  return { expired: expired.length, purged: due.length };
}

function registerBillingJobHandlers() {
  registerJobHandler('billing_reminder', (p) => handleReminder(p));
  registerJobHandler('billing_autorenew', (p) => handleAutoRenew(p));
  registerJobHandler('billing_expire', (p) => handleExpire(p));
  registerJobHandler('billing_purge_warning', (p) => handlePurgeWarning(p));
  registerJobHandler('billing_purge', (p) => handlePurge(p));
  registerJobHandler('billing_announce', (p) => handleAnnounce(p));
  registerJobHandler('billing_grace_reminder', (p) => handleGraceReminder(p));
  registerJobHandler('billing_grace_end', (p) => handleGraceEnd(p));
  registerJobHandler('billing_compensate', (p) => handleCompensate(p));
  registerJobHandler('verification_recompute_all', () => handleRecomputeVerifications());
}

module.exports = {
  registerBillingJobHandlers,
  catchUpDue,
  // Exposés pour les essais de bout en bout (compte testeur, fin raccourcie).
  handleReminder,
  handleExpire,
  handlePurge,
};
