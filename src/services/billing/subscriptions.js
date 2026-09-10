/**
 * Périodes d'abonnement : ajout seul, jamais de modification.
 *
 * Toute période naît ici — d'un paiement confirmé (paymentService), d'un
 * geste de l'administration (abonnement offert), et plus tard d'un essai ou
 * d'une compensation. La fin de la dernière période est dénormalisée sur
 * `subscriber.current_end`, que les balayages d'échéance lisent.
 */

const pool = require('../../config/db');
const { PERIOD_SOURCE } = require('../../constants/billing');
const { emitToUser } = require('../../utils/userSocketRegistry');
const { BillingError } = require('./errors');
const { getBillingSettings } = require('./settings');
const { phaseAt } = require('./rules');
const { addMonths, nextPeriodStart } = require('../payments/paymentRules');

let _io = null;

/** Les jobs tournent hors requête : on leur donne `io` explicitement. */
function setBillingIo(io) {
  _io = io;
}

/**
 * Les droits d'un compte viennent de changer : son téléphone relit
 * `/billing/me`. On n'envoie pas les droits eux-mêmes — un seul chemin de
 * calcul, celui de la route.
 */
function notifyEntitlementsChanged(alanyaID) {
  if (_io) emitToUser(_io, alanyaID, 'entitlements:updated', { at: new Date().toISOString() });
}

function emitToAccount(alanyaID, event, payload) {
  if (_io) emitToUser(_io, alanyaID, event, payload);
}

/**
 * Verrouille la ligne `subscriber` du compte (la crée au besoin). Deux
 * confirmations simultanées pour le même compte s'y sérialisent : la seconde
 * voit la fin posée par la première et s'enchaîne après elle.
 */
async function lockSubscriber(conn, alanyaID) {
  await conn.execute('INSERT IGNORE INTO subscriber (alanyaID) VALUES (?)', [alanyaID]);
  const [[row]] = await conn.execute('SELECT * FROM subscriber WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
  return row;
}

/**
 * Ajoute une période à la suite de ce qui court déjà. À appeler dans une
 * transaction ouverte.
 *
 * @returns {Promise<{ start: Date, end: Date }>}
 */
async function appendPeriod(conn, {
  alanyaID, plan, now = new Date(), graceUntil = null, source,
  paymentId = null, grantedBy = null, reason = null, months = null,
}) {
  const sub = await lockSubscriber(conn, alanyaID);
  const start = nextPeriodStart({ now, currentEnd: sub.current_end, graceUntil });
  const end = addMonths(start, months ?? Number(plan.duration_months));
  await conn.execute(
    `INSERT INTO subscription_period
       (alanyaID, plan_id, starts_at, ends_at, source, payment_id, granted_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [alanyaID, plan.id, start, end, source, paymentId, grantedBy, reason],
  );
  // Une nouvelle période efface l'échéance de purge : les données payantes
  // conservées depuis l'expiration redeviennent simplement actives.
  await conn.execute(
    `UPDATE subscriber
        SET current_end = ?, renew_plan_id = COALESCE(renew_plan_id, ?),
            purge_after = NULL, purged_at = NULL
      WHERE alanyaID = ?`,
    [end, plan.id, alanyaID],
  );
  return { start, end };
}

/** Grâce à ne pas consommer, si elle est en cours. */
async function graceToPreserve(now = new Date()) {
  const settings = await getBillingSettings();
  return phaseAt(settings, now) === 'grace' ? settings.grace_until : null;
}

/**
 * Abonnement offert par l'administration : une période de plus, jamais un
 * faux paiement. Le plan retenu est celui mis en avant (il porte l'offre
 * complète) ; la durée est celle choisie par l'administrateur.
 */
async function grantGift({ alanyaID, months, reason, adminId, now = new Date() }) {
  const [[user]] = await pool.execute('SELECT alanyaID FROM users WHERE alanyaID = ?', [alanyaID]);
  if (!user) throw new BillingError('USER_NOT_FOUND', 404, 'Utilisateur introuvable');
  const [[plan]] = await pool.execute(
    'SELECT * FROM plan WHERE is_active = 1 ORDER BY is_featured DESC, duration_months DESC, id ASC LIMIT 1',
  );
  if (!plan) throw new BillingError('PLAN_NOT_FOUND', 404, 'Aucun plan actif à offrir');

  const graceUntil = await graceToPreserve(now);
  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    result = await appendPeriod(conn, {
      alanyaID, plan, now, graceUntil, source: PERIOD_SOURCE.GIFT,
      grantedBy: adminId, reason, months,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  notifyEntitlementsChanged(alanyaID);
  return result;
}

module.exports = {
  setBillingIo,
  notifyEntitlementsChanged,
  emitToAccount,
  lockSubscriber,
  appendPeriod,
  graceToPreserve,
  grantGift,
};
