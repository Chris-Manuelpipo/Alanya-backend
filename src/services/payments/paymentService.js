/**
 * Paiements : demande, webhook, confirmation, réconciliation.
 *
 * Une seule fonction crée une période à partir d'un paiement :
 * `settlePayment`. Le simulateur y arrive par un job, un agrégateur par sa
 * route de webhook, la réconciliation par `fetchStatus` — toujours par elle.
 */

const crypto = require('crypto');
const pool = require('../../config/db');
const { registerJobHandler } = require('../jobQueue');
const {
  PAYMENT_STATUS: P, PAYMENT_PURPOSE, PERIOD_SOURCE, PHASE,
} = require('../../constants/billing');
const { BillingError } = require('../billing/errors');
const { getBillingSettings } = require('../billing/settings');
const { phaseAt, isBillingTester } = require('../billing/rules');
const {
  appendPeriod, graceToPreserve, notifyEntitlementsChanged, emitToAccount,
} = require('../billing/subscriptions');
const { scheduleChainJobs } = require('../billing/billingSchedule');
const { pushBilling, messages } = require('../billing/billingNotify');
const providers = require('./providers');
const simulated = require('./providers/simulated');
const { PAYMENT_STATUS_NAME, normalizeMsisdn } = require('./paymentRules');

/** Un paiement sans réponse de l'opérateur au-delà expire. */
const PENDING_TTL_MS = 30 * 60_000;
/** Délai avant de demander au fournisseur ce qu'il en est. */
const RECONCILE_AFTER_MS = 2 * 60_000;

const FINAL = new Set([P.SUCCEEDED, P.FAILED, P.EXPIRED, P.REFUNDED]);

function emitPaymentUpdate(alanyaID, paymentId, status) {
  emitToAccount(alanyaID, 'payment:updated', {
    paymentId,
    status: PAYMENT_STATUS_NAME[status],
  });
}

/**
 * Demande un paiement. Ne confirme rien : la confirmation n'arrive que par le
 * fournisseur. Hors phase payante, l'offre n'est pas en vente — sauf pour les
 * comptes testeurs.
 */
async function checkout({ alanyaID, planCode, channel, msisdn, autoRenew, now = new Date() }) {
  const settings = await getBillingSettings();
  const effective = isBillingTester(alanyaID) ? { ...settings, paid_enabled: 1, grace_until: null } : settings;
  if (phaseAt(effective, now) === PHASE.FREE) {
    throw new BillingError('BILLING_NOT_ACTIVE', 409, 'L\'offre n\'est pas encore proposée');
  }

  const [[plan]] = await pool.execute('SELECT * FROM plan WHERE code = ? AND is_active = 1', [String(planCode || '')]);
  if (!plan) throw new BillingError('PLAN_NOT_FOUND', 404, 'Plan introuvable');

  const provider = providers.active();
  if (!provider.channels.includes(channel)) {
    throw new BillingError('INVALID_CHANNEL', 400, 'Moyen de paiement non proposé');
  }
  const number = normalizeMsisdn(msisdn);
  if (!number) throw new BillingError('INVALID_MSISDN', 400, 'Numéro de téléphone invalide');

  // Un seul paiement en attente à la fois : deux demandes simultanées
  // feraient composer deux codes au même utilisateur.
  const pending = await pendingPaymentId(alanyaID, now);
  if (pending) {
    throw new BillingError('PAYMENT_PENDING', 409, 'Un paiement est déjà en attente', { paymentId: pending });
  }

  if (typeof autoRenew === 'boolean') {
    await pool.execute(
      `INSERT INTO subscriber (alanyaID, auto_renew) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE auto_renew = VALUES(auto_renew)`,
      [alanyaID, autoRenew ? 1 : 0],
    );
  }

  return startPayment({
    alanyaID, plan, provider, channel, number, purpose: PAYMENT_PURPOSE.SUBSCRIBE,
  });
}

async function pendingPaymentId(alanyaID, now = new Date()) {
  const [[pending]] = await pool.execute(
    `SELECT id FROM payment
      WHERE alanyaID = ? AND status IN (?, ?) AND created_at > ?
      ORDER BY id DESC LIMIT 1`,
    [alanyaID, P.CREATED, P.PENDING, new Date(now.getTime() - PENDING_TTL_MS)],
  );
  return pending?.id ?? null;
}

/**
 * Renouvellement automatique, la veille de l'échéance (job
 * `billing_autorenew`) : même demande qu'une souscription, sur le dernier
 * moyen de paiement confirmé et la durée choisie pour la suite. L'opérateur
 * demande son code à l'utilisateur ; rien n'est débité sans lui.
 *
 * @returns {Promise<object|null>} la demande, ou null s'il n'y a rien à faire
 */
async function initiateRenewal({ alanyaID, now = new Date() }) {
  const [[sub]] = await pool.execute('SELECT * FROM subscriber WHERE alanyaID = ?', [alanyaID]);
  if (!sub || Number(sub.auto_renew) !== 1 || !sub.renew_msisdn || !sub.renew_channel) return null;
  const [[plan]] = await pool.execute(
    `SELECT * FROM plan
      WHERE is_active = 1 AND id = COALESCE(?, (
        SELECT plan_id FROM subscription_period WHERE alanyaID = ? ORDER BY ends_at DESC LIMIT 1))`,
    [sub.renew_plan_id, alanyaID],
  );
  if (!plan) return null;
  const provider = providers.active();
  if (!provider.channels.includes(sub.renew_channel)) return null;
  if (await pendingPaymentId(alanyaID, now)) return null;
  const started = await startPayment({
    alanyaID, plan, provider, channel: sub.renew_channel, number: sub.renew_msisdn,
    purpose: PAYMENT_PURPOSE.AUTO_RENEW,
  });
  return { ...started, channel: sub.renew_channel };
}

/** Enregistre la demande, puis la confie au fournisseur. */
async function startPayment({ alanyaID, plan, provider, channel, number, purpose }) {
  const [ins] = await pool.execute(
    `INSERT INTO payment
       (alanyaID, plan_id, provider, channel, msisdn, amount, currency, purpose, status, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [alanyaID, plan.id, provider.name, channel, number, plan.price_amount, plan.currency,
      purpose, P.CREATED, crypto.randomUUID()],
  );
  const paymentId = ins.insertId;

  try {
    const r = await provider.initiate({
      paymentId, amount: plan.price_amount, currency: plan.currency, msisdn: number,
    });
    await pool.execute(
      'UPDATE payment SET provider_ref = ?, status = ? WHERE id = ? AND status = ?',
      [r.providerRef, P.PENDING, paymentId, P.CREATED],
    );
    return {
      paymentId,
      status: 'pending',
      plan: plan.code,
      amount: plan.price_amount,
      currency: plan.currency,
      provider: provider.name,
      nextAction: r.nextAction ?? null,
    };
  } catch (err) {
    console.error('[paiement] fournisseur injoignable :', err.message);
    await pool.execute(
      'UPDATE payment SET status = ?, failure_code = ? WHERE id = ?',
      [P.FAILED, 'PROVIDER_ERROR', paymentId],
    );
    throw new BillingError('PAYMENT_PROVIDER_ERROR', 502, 'Le fournisseur de paiement n\'a pas répondu');
  }
}

/**
 * Le seul chemin d'un paiement vers une période. Rejouable sans effet : le
 * verrou sérialise deux confirmations simultanées, le contrôle de statut rend
 * la seconde inopérante, et `uq_period_payment` refuserait de toute façon une
 * seconde période pour le même paiement.
 *
 * @param {'succeeded'|'failed'|'expired'|'pending'} outcome
 */
async function settlePayment(paymentId, { outcome, failureCode = null }, now = new Date()) {
  const conn = await pool.getConnection();
  let alanyaID = null;
  let status = null;
  let changed = false;
  let plan = null;
  let appended = null;
  let finalFailure = null;
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.execute('SELECT * FROM payment WHERE id = ? FOR UPDATE', [paymentId]);
    if (!p) throw new BillingError('PAYMENT_NOT_FOUND', 404, 'Paiement introuvable');
    alanyaID = p.alanyaID;
    status = Number(p.status);

    if (!FINAL.has(status)) {
      if (outcome === 'succeeded') {
        [[plan]] = await conn.execute('SELECT * FROM plan WHERE id = ?', [p.plan_id]);
        appended = await appendPeriod(conn, {
          alanyaID, plan, now, graceUntil: await graceToPreserve(now),
          source: PERIOD_SOURCE.PAYMENT, paymentId: p.id,
        });
        await conn.execute(
          'UPDATE subscriber SET renew_channel = ?, renew_msisdn = ? WHERE alanyaID = ?',
          [p.channel, p.msisdn, alanyaID],
        );
        await conn.execute('UPDATE payment SET status = ?, confirmed_at = ? WHERE id = ?', [P.SUCCEEDED, now, p.id]);
        status = P.SUCCEEDED;
        changed = true;
      } else if (outcome === 'failed' || outcome === 'expired') {
        status = outcome === 'failed' ? P.FAILED : P.EXPIRED;
        finalFailure = String(failureCode || (outcome === 'expired' ? 'TIMEOUT' : 'FAILED')).slice(0, 40);
        await conn.execute(
          'UPDATE payment SET status = ?, failure_code = ? WHERE id = ?',
          [status, finalFailure, p.id],
        );
        changed = true;
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (changed) {
    emitPaymentUpdate(alanyaID, paymentId, status);
    if (status === P.SUCCEEDED) {
      notifyEntitlementsChanged(alanyaID);
      try {
        await scheduleChainJobs(alanyaID, appended.end, Number(plan.reminder_days), now);
      } catch (err) {
        console.error(`[paiement] jobs d'échéance de ${alanyaID} :`, err.message);
      }
    }
    // L'écran d'attente, s'il est ouvert, dit déjà la même chose : la
    // notification sert à qui a quitté l'application (renouvellement
    // automatique, code composé plus tard).
    const message = status === P.SUCCEEDED
      ? messages.paymentSucceeded({ until: appended.end })
      : messages.paymentFailed({ failureCode: finalFailure });
    await pushBilling(alanyaID, message, { skipIfDeviceOnline: true });
  }
  return { status: PAYMENT_STATUS_NAME[status], changed };
}

const safeJson = (buf) => {
  try { return JSON.parse(buf.toString('utf8')); } catch { return { brut: buf.toString('utf8').slice(0, 2000) }; }
};

/**
 * Tout ce qu'un fournisseur envoie. Journalisé avant toute décision, signature
 * valide ou non : c'est la trace qu'on relit quand un paiement est contesté.
 */
async function handleWebhook(providerName, { headers, rawBody }) {
  const provider = providers.get(providerName);
  if (!provider) throw new BillingError('PAYMENT_PROVIDER_UNKNOWN', 404, 'Fournisseur inconnu');

  let parsed;
  try {
    parsed = provider.parseWebhook({ headers, rawBody });
  } catch (err) {
    parsed = { signatureOk: false, providerRef: null, eventType: 'illisible', raw: safeJson(rawBody) };
  }

  const [[payment]] = parsed.providerRef
    ? await pool.execute(
      'SELECT id FROM payment WHERE provider = ? AND provider_ref = ?',
      [providerName, parsed.providerRef],
    )
    : [[null]];

  await pool.execute(
    `INSERT INTO payment_event (payment_id, provider, event_type, signature_ok, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [payment?.id ?? null, providerName, String(parsed.eventType || 'inconnu').slice(0, 40),
      parsed.signatureOk ? 1 : 0, JSON.stringify(parsed.raw ?? {})],
  );

  if (!parsed.signatureOk) throw new BillingError('INVALID_SIGNATURE', 401, 'Signature invalide');
  // Référence inconnue : on accuse réception pour que le fournisseur cesse
  // de rejouer, la ligne de journal suffit à l'enquête.
  if (!payment) return { accepted: false, reason: 'unknown_ref' };

  const settled = await settlePayment(payment.id, parsed);
  return { accepted: true, status: settled.status };
}

/**
 * Réconciliation : un webhook peut se perdre. Au-delà de deux minutes, on
 * demande au fournisseur ; au-delà de trente, le paiement expire.
 */
async function reconcilePending(now = new Date()) {
  const [rows] = await pool.execute(
    `SELECT id, provider, provider_ref, created_at FROM payment
      WHERE status IN (?, ?) AND created_at < ?
      ORDER BY id ASC LIMIT 200`,
    [P.CREATED, P.PENDING, new Date(now.getTime() - RECONCILE_AFTER_MS)],
  );
  let settled = 0;
  for (const row of rows) {
    try {
      if (now - new Date(row.created_at) > PENDING_TTL_MS) {
        await settlePayment(row.id, { outcome: 'expired', failureCode: 'TIMEOUT' }, now);
        settled++;
        continue;
      }
      const provider = providers.get(row.provider);
      if (!provider || !row.provider_ref) continue;
      const r = await provider.fetchStatus(row.provider_ref);
      if (r.outcome === 'succeeded' || r.outcome === 'failed') {
        await settlePayment(row.id, r, now);
        settled++;
      }
    } catch (err) {
      console.error(`[paiement] réconciliation ${row.id} :`, err.message);
    }
  }
  return { examined: rows.length, settled };
}

/** Le simulateur rappelle par la file de jobs, via le chemin du webhook. */
function registerPaymentJobHandlers() {
  registerJobHandler('payment_sim_callback', async (event) => {
    const rawBody = Buffer.from(JSON.stringify(event));
    await handleWebhook(simulated.name, {
      headers: { 'x-simulator-signature': simulated.sign(rawBody) },
      rawBody,
    });
  });
}

module.exports = {
  checkout,
  initiateRenewal,
  settlePayment,
  handleWebhook,
  reconcilePending,
  registerPaymentJobHandlers,
};
