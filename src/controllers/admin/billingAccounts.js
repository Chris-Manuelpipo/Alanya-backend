/**
 * Administration de l'abonnement, côté comptes : paiements, abonnés, carte
 * d'un compte, abonnement offert.
 *
 * Offrir est un geste commercial : une période de plus, jamais un faux
 * paiement. Le motif est obligatoire et suit le geste dans le journal.
 */

const pool = require('../../config/db');
const { fail, failInternal } = require('../../utils/apiError');
const { BillingError } = require('../../services/billing/errors');
const { entitlementsFor } = require('../../services/billing/entitlements');
const { grantGift } = require('../../services/billing/subscriptions');
const { parseReason } = require('../../services/billing/rules');
const { PAYMENT_STATUS_NAME } = require('../../services/payments/paymentRules');

function sendError(res, err, tag) {
  if (err instanceof BillingError) return fail(res, err.status, err.code, err.message, err.extra);
  console.error(`[admin/billing] ${tag} :`, err);
  return failInternal(res);
}

const limitOf = (raw, max = 200) => Math.min(max, Math.max(1, parseInt(raw, 10) || 50));

const STATUS_BY_NAME = Object.fromEntries(Object.entries(PAYMENT_STATUS_NAME).map(([k, v]) => [v, Number(k)]));

const paymentRow = (p) => ({
  id: p.id,
  alanya_id: p.alanyaID,
  user_name: p.nom || p.pseudo || null,
  plan: p.plan_code,
  provider: p.provider,
  channel: p.channel,
  msisdn: p.msisdn ? `${p.msisdn.slice(0, 5)}•••${p.msisdn.slice(-3)}` : null,
  amount: Number(p.amount),
  currency: p.currency,
  status: PAYMENT_STATUS_NAME[p.status],
  provider_ref: p.provider_ref,
  failure_code: p.failure_code,
  created_at: p.created_at,
  confirmed_at: p.confirmed_at,
});

/** GET /admin/billing/payments?status=&provider=&before=&limit= */
const listBillingPayments = async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status && STATUS_BY_NAME[req.query.status] !== undefined) {
      where.push('p.status = ?');
      params.push(STATUS_BY_NAME[req.query.status]);
    }
    if (req.query.provider) {
      where.push('p.provider = ?');
      params.push(String(req.query.provider));
    }
    const before = parseInt(req.query.before, 10);
    if (Number.isInteger(before) && before > 0) {
      where.push('p.id < ?');
      params.push(before);
    }
    const [rows] = await pool.execute(
      `SELECT p.*, u.nom, u.pseudo, pl.code AS plan_code
         FROM payment p
         JOIN users u ON u.alanyaID = p.alanyaID
         JOIN plan pl ON pl.id = p.plan_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.id DESC
        LIMIT ${limitOf(req.query.limit)}`,
      params,
    );
    res.json({ payments: rows.map(paymentRow) });
  } catch (err) {
    return sendError(res, err, 'paiements');
  }
};

/** GET /admin/billing/subscribers?filter=active|expiring|expired|all */
const listBillingSubscribers = async (req, res) => {
  try {
    const filter = String(req.query.filter || 'active');
    const clauses = {
      active: 's.current_end > NOW()',
      expiring: 's.current_end > NOW() AND s.current_end <= DATE_ADD(NOW(), INTERVAL 30 DAY)',
      expired: 's.current_end <= NOW()',
      all: '1 = 1',
    };
    const where = clauses[filter] || clauses.active;
    const [rows] = await pool.execute(
      `SELECT s.alanyaID, s.current_end, s.auto_renew, s.renew_channel, s.purge_after,
              u.nom, u.pseudo, u.alanyaPhone,
              (SELECT pl.code FROM subscription_period sp JOIN plan pl ON pl.id = sp.plan_id
                WHERE sp.alanyaID = s.alanyaID ORDER BY sp.ends_at DESC LIMIT 1) AS plan_code
         FROM subscriber s
         JOIN users u ON u.alanyaID = s.alanyaID
        WHERE s.current_end IS NOT NULL AND ${where}
        ORDER BY s.current_end ASC
        LIMIT ${limitOf(req.query.limit)}`,
    );
    res.json({
      subscribers: rows.map((r) => ({
        alanya_id: r.alanyaID,
        user_name: r.nom || r.pseudo || null,
        alanya_phone: r.alanyaPhone,
        plan: r.plan_code,
        current_end: r.current_end,
        auto_renew: Number(r.auto_renew) === 1,
        renew_channel: r.renew_channel,
        purge_after: r.purge_after,
      })),
    });
  } catch (err) {
    return sendError(res, err, 'abonnés');
  }
};

async function userBillingPayload(alanyaID) {
  const [entitlements, [periods], [pays], [[sub]]] = await Promise.all([
    entitlementsFor(alanyaID),
    pool.execute(
      `SELECT sp.id, sp.starts_at, sp.ends_at, sp.source, sp.payment_id, sp.reason,
              pl.code AS plan_code, g.nom AS granted_by_name
         FROM subscription_period sp
         JOIN plan pl ON pl.id = sp.plan_id
         LEFT JOIN users g ON g.alanyaID = sp.granted_by
        WHERE sp.alanyaID = ? ORDER BY sp.starts_at DESC LIMIT 50`,
      [alanyaID],
    ),
    pool.execute(
      `SELECT p.*, NULL AS nom, NULL AS pseudo, pl.code AS plan_code
         FROM payment p JOIN plan pl ON pl.id = p.plan_id
        WHERE p.alanyaID = ? ORDER BY p.id DESC LIMIT 50`,
      [alanyaID],
    ),
    pool.execute('SELECT * FROM subscriber WHERE alanyaID = ?', [alanyaID]),
  ]);
  return {
    entitlements,
    subscriber: sub
      ? {
        current_end: sub.current_end,
        auto_renew: Number(sub.auto_renew) === 1,
        renew_channel: sub.renew_channel,
        purge_after: sub.purge_after,
      }
      : null,
    periods: periods.map((p) => ({
      id: p.id,
      plan: p.plan_code,
      starts_at: p.starts_at,
      ends_at: p.ends_at,
      source: Number(p.source),
      payment_id: p.payment_id,
      reason: p.reason,
      granted_by_name: p.granted_by_name,
    })),
    payments: pays.map(paymentRow),
  };
}

/** GET /admin/users/:id/billing — la carte « Abonnement et coche » d'un compte. */
const getUserBilling = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 404, 'USER_NOT_FOUND', 'Utilisateur introuvable');
  try {
    res.json(await userBillingPayload(id));
  } catch (err) {
    return sendError(res, err, 'carte d\'abonnement');
  }
};

/** POST /admin/users/:id/billing/gift — { months: 1..24, reason } */
const giftSubscription = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 404, 'USER_NOT_FOUND', 'Utilisateur introuvable');
  const reason = parseReason(req.body);
  if (!reason.ok) return fail(res, 400, reason.code, reason.error);
  const months = Number(req.body?.months);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    return fail(res, 400, 'INVALID_GIFT', 'Durée offerte : de 1 à 24 mois');
  }
  try {
    const period = await grantGift({ alanyaID: id, months, reason: reason.value, adminId: req.user.alanyaID });
    res.status(201).json({ gifted: period, ...(await userBillingPayload(id)) });
  } catch (err) {
    return sendError(res, err, 'abonnement offert');
  }
};

module.exports = {
  listBillingPayments,
  listBillingSubscribers,
  getUserBilling,
  giftSubscription,
};
