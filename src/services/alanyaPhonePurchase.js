/**
 * Le numéro choisi : vérifier, mettre de côté, payer.
 *
 * Le parcours tient en trois gestes, chacun sa route :
 *
 * 1. `check`    — le numéro est-il à vendre ? Rien n'est retenu.
 * 2. `hold`     — le numéro est mis de côté 15 minutes au nom du compte ; la
 *                 base refuse qu'un autre le retienne en même temps (index
 *                 UNIQUE sur `active_phone`).
 * 3. `checkout` — la demande de paiement naît dans la même transaction que le
 *                 passage de la commande en « paiement en cours ». Dès lors le
 *                 numéro reste retenu jusqu'à la réponse de l'opérateur, et
 *                 c'est `settlePayment` qui le pose, dans sa transaction.
 *
 * Un crédit (paiement acquis, numéro pris entre-temps) court-circuite le
 * troisième geste : le numéro choisi ensuite est posé sans nouveau paiement.
 */

const pool = require('../config/db');
const { BillingError } = require('./billing/errors');
const { purchaseBlocker } = require('./billing/rules');
const { PAYMENT_PURPOSE, PAYMENT_STATUS: P, PHONE_ORDER_STATUS: O, PHONE_CHANGE } = require('../constants/billing');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');
const { normalize, validatePurchasable } = require('../utils/alanyaPhone');
const { purchaseAvailability } = require('./alanyaPhoneService');
const { applyOrder } = require('./alanyaPhoneOrders');
const payments = require('./payments/paymentService');
const providers = require('./payments/providers');

const MINUTE_MS = 60_000;

const ORDER_STATUS_NAME = Object.freeze({
  [O.HELD]: 'held',
  [O.PAYING]: 'paying',
  [O.APPLIED]: 'applied',
  [O.ABANDONED]: 'abandoned',
  [O.CREDIT]: 'credit',
});

const orderView = (o) => (o ? {
  id: o.id,
  phone: o.phone_canonical,
  status: ORDER_STATUS_NAME[Number(o.status)],
  heldUntil: o.held_until,
  paymentId: o.payment_id,
} : null);

async function loadAccount(alanyaID, conn = pool, { lock = false } = {}) {
  const [[account]] = await conn.execute(
    `SELECT alanyaID, alanyaPhone, account_type FROM users WHERE alanyaID = ?${lock ? ' FOR UPDATE' : ''}`,
    [alanyaID],
  );
  if (!account) throw new BillingError('USER_NOT_FOUND', 404, 'Utilisateur introuvable');
  return account;
}

/** Pourquoi ce compte ne peut pas acheter, ou null. */
function buyingBlocker(account) {
  if (Number(account.account_type) === ACCOUNT_TYPE.OFFICIEL) return 'OFFICIAL_PHONE_FIXED';
  return purchaseBlocker(account.alanyaID) ? 'PHONE_PURCHASE_UNAVAILABLE' : null;
}

function assertCanBuy(account) {
  const blocker = buyingBlocker(account);
  if (blocker === 'OFFICIAL_PHONE_FIXED') {
    throw new BillingError(blocker, 403, 'Le numéro du compte officiel ne change pas');
  }
  if (blocker) throw new BillingError(blocker, 403, 'Le choix du numéro n\'est pas encore proposé');
}

function parsePhone(raw) {
  const canonical = normalize(raw);
  const v = validatePurchasable(canonical);
  if (!v.ok) throw new BillingError(v.code, 400, v.error);
  return canonical;
}

/**
 * La commande qui occupe le compte : paiement en cours, mise de côté non
 * échue, ou crédit à utiliser. Une seule à la fois (index `uq_order_active_user`
 * pour les deux premiers ; un crédit ne naît que d'un paiement en cours).
 */
async function currentOrder(alanyaID, now, conn = pool) {
  const [[order]] = await conn.execute(
    `SELECT * FROM alanya_phone_order
      WHERE alanyaID = ?
        AND (status IN (?, ?) OR (status = ? AND held_until > ?))
      ORDER BY id DESC LIMIT 1`,
    [alanyaID, O.PAYING, O.CREDIT, O.HELD, now],
  );
  return order ?? null;
}

/** GET /alanya-phone/offer — tout l'écran en un appel, et la reprise d'une commande en cours. */
async function offer(alanyaID, now = new Date()) {
  const account = await loadAccount(alanyaID);
  let provider = null;
  try {
    const p = providers.active();
    provider = { name: p.name, channels: p.channels, simulated: p.name === 'simulated' };
  } catch {
    provider = null;
  }
  const order = await currentOrder(alanyaID, now);
  return {
    purchasable: !buyingBlocker(account) && provider != null,
    price: PHONE_CHANGE.price,
    currency: PHONE_CHANGE.currency,
    holdMinutes: PHONE_CHANGE.holdMinutes,
    provider,
    currentPhone: account.alanyaPhone,
    order: order && Number(order.status) !== O.CREDIT ? orderView(order) : null,
    credit: Number(order?.status) === O.CREDIT,
  };
}

/** GET /alanya-phone/check?phone= — le numéro est-il à vendre ? Rien n'est retenu. */
async function check(alanyaID, rawPhone, now = new Date()) {
  const canonical = parsePhone(rawPhone);
  const account = await loadAccount(alanyaID);
  assertCanBuy(account);
  const { available, reason } = await purchaseAvailability(canonical, {
    alanyaID, currentPhone: account.alanyaPhone, now,
  });
  return {
    phone: canonical, available, reason, price: PHONE_CHANGE.price, currency: PHONE_CHANGE.currency,
  };
}

/**
 * POST /alanya-phone/hold — met le numéro de côté, ou le pose tout de suite
 * s'il reste un crédit.
 *
 * Le compte est verrouillé le temps de la transaction : deux demandes du même
 * compte passent l'une après l'autre. Deux comptes qui visent le même numéro
 * au même instant se heurtent à l'index UNIQUE ; le second apprend qu'il est
 * retenu.
 *
 * @returns {Promise<{ order: object|null, applied?: boolean, credit?: boolean, phone?: string }>}
 */
async function hold(alanyaID, rawPhone, now = new Date()) {
  const canonical = parsePhone(rawPhone);
  const conn = await pool.getConnection();
  let result;
  let settled = null;
  try {
    await conn.beginTransaction();
    // Commandes d'abord, compte ensuite : l'ordre de `settlePayment`
    // (paiement → commande → compte). Dans l'ordre inverse, retenir un numéro
    // pendant que son paiement se confirme ferait un interblocage.
    const [mine] = await conn.execute(
      'SELECT * FROM alanya_phone_order WHERE alanyaID = ? AND status IN (?, ?) ORDER BY id DESC FOR UPDATE',
      [alanyaID, O.PAYING, O.CREDIT],
    );
    const account = await loadAccount(alanyaID, conn, { lock: true });
    assertCanBuy(account);

    const paying = mine.find((o) => Number(o.status) === O.PAYING);
    if (paying) {
      throw new BillingError('PHONE_ORDER_PENDING', 409, 'Un paiement de numéro est déjà en cours', {
        orderId: paying.id, paymentId: paying.payment_id,
      });
    }
    const credit = mine.find((o) => Number(o.status) === O.CREDIT) ?? null;

    // Solder ce qui gênerait : sa propre mise de côté (on change d'avis), et
    // une mise de côté échue d'un autre sur ce numéro — aucun job ne les solde.
    await conn.execute(
      'UPDATE alanya_phone_order SET status = ? WHERE alanyaID = ? AND status = ?',
      [O.ABANDONED, alanyaID, O.HELD],
    );
    await conn.execute(
      'UPDATE alanya_phone_order SET status = ? WHERE active_phone = ? AND status = ? AND held_until <= ?',
      [O.ABANDONED, canonical, O.HELD, now],
    );

    const { available, reason } = await purchaseAvailability(canonical, {
      alanyaID, currentPhone: account.alanyaPhone, now, conn,
    });
    if (!available) {
      throw new BillingError('PHONE_UNAVAILABLE', 409, 'Ce numéro n\'est pas disponible', { reason });
    }

    if (credit) {
      // Déjà payé : le numéro passe par l'état « paiement en cours » — donc par
      // l'index UNIQUE — puis il est posé dans la même transaction.
      await conn.execute(
        'UPDATE alanya_phone_order SET phone_canonical = ?, status = ? WHERE id = ?',
        [canonical, O.PAYING, credit.id],
      );
      settled = await applyOrder(conn, { ...credit, phone_canonical: canonical }, now);
      result = { order: null, applied: settled.applied, credit: !settled.applied, phone: canonical };
    } else {
      const heldUntil = new Date(now.getTime() + PHONE_CHANGE.holdMinutes * MINUTE_MS);
      const [ins] = await conn.execute(
        'INSERT INTO alanya_phone_order (alanyaID, phone_canonical, status, held_until) VALUES (?, ?, ?, ?)',
        [alanyaID, canonical, O.HELD, heldUntil],
      );
      result = {
        order: orderView({
          id: ins.insertId, phone_canonical: canonical, status: O.HELD, held_until: heldUntil, payment_id: null,
        }),
      };
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      // Un autre appareil du compte vient de lancer un paiement : c'est
      // l'index par compte qui a refusé, pas celui du numéro.
      if (/uq_order_active_user/.test(err.message)) {
        throw new BillingError('PHONE_ORDER_PENDING', 409, 'Un paiement de numéro est déjà en cours');
      }
      throw new BillingError('PHONE_UNAVAILABLE', 409, 'Ce numéro vient d\'être retenu', { reason: 'held' });
    }
    throw err;
  } finally {
    conn.release();
  }

  if (settled) {
    await payments.announcePhoneSettlement({ alanyaID, status: P.SUCCEEDED, change: settled });
  }
  return result;
}

/** DELETE /alanya-phone/hold — lève sa mise de côté. Un paiement en cours, lui, attend sa réponse. */
async function release(alanyaID) {
  const [r] = await pool.execute(
    'UPDATE alanya_phone_order SET status = ? WHERE alanyaID = ? AND status = ?',
    [O.ABANDONED, alanyaID, O.HELD],
  );
  return { released: r.affectedRows > 0 };
}

/**
 * POST /alanya-phone/checkout — { orderId, channel, msisdn }
 *
 * La demande de paiement et le passage de la commande en « paiement en
 * cours » naissent ensemble : aucun instant où le paiement existerait sans
 * que le numéro soit retenu pour lui.
 */
async function checkout(alanyaID, { orderId, channel, msisdn }, now = new Date()) {
  const account = await loadAccount(alanyaID);
  assertCanBuy(account);
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new BillingError('PHONE_ORDER_NOT_FOUND', 404, 'Commande introuvable');

  const { provider, number } = await payments.preparePayment({ alanyaID, channel, msisdn, now });
  const amount = PHONE_CHANGE.price;
  const { currency } = PHONE_CHANGE;

  const conn = await pool.getConnection();
  let paymentId;
  let phone;
  try {
    await conn.beginTransaction();
    const [[order]] = await conn.execute(
      'SELECT * FROM alanya_phone_order WHERE id = ? AND alanyaID = ? FOR UPDATE',
      [id, alanyaID],
    );
    if (!order) throw new BillingError('PHONE_ORDER_NOT_FOUND', 404, 'Commande introuvable');
    const status = Number(order.status);
    if (status === O.PAYING) {
      // Double appui, écran rouvert : l'application reprend l'attente.
      throw new BillingError('PAYMENT_PENDING', 409, 'Un paiement est déjà en attente', { paymentId: order.payment_id });
    }
    if (status !== O.HELD || new Date(order.held_until) <= now) {
      throw new BillingError('PHONE_HOLD_EXPIRED', 409, 'La mise de côté du numéro a expiré');
    }
    phone = order.phone_canonical;
    paymentId = await payments.insertPayment(conn, {
      alanyaID, planId: null, provider, channel, number, amount, currency, purpose: PAYMENT_PURPOSE.PHONE_NUMBER,
    });
    await conn.execute(
      'UPDATE alanya_phone_order SET status = ?, payment_id = ? WHERE id = ?',
      [O.PAYING, paymentId, id],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const started = await payments.initiatePayment({ paymentId, provider, number, amount, currency });
  return { ...started, product: 'phone', orderId: id, phone };
}

module.exports = {
  ORDER_STATUS_NAME,
  offer,
  check,
  hold,
  release,
  checkout,
};
