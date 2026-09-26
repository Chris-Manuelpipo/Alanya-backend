/**
 * Commandes de numéro : ce qui se passe DANS une transaction.
 *
 * `settlePayment` appelle ce module avec sa connexion, la ligne `payment` déjà
 * verrouillée : le paiement, la commande et le numéro du compte changent
 * ensemble, ou pas du tout. Le module ne dépend pas du service de paiement —
 * c'est le paiement qui l'appelle, jamais l'inverse.
 */

const { PHONE_ORDER_STATUS: O, PHONE_CHANGE_SOURCE } = require('../constants/billing');

/**
 * Inscrit un changement de numéro : `users`, puis l'historique dont se déduit
 * la quarantaine de l'ancien. Partagé avec l'administration.
 *
 * Lève ER_DUP_ENTRY (contrainte `uq_phone`) si le nouveau numéro est porté par
 * un autre compte : à l'appelant de trancher. InnoDB n'annule alors que
 * l'instruction fautive — la transaction reste utilisable.
 */
async function recordPhoneChange(conn, {
  alanyaID, oldPhone, newPhone, source, orderId = null, changedBy = null, now = new Date(),
}) {
  await conn.execute('UPDATE users SET alanyaPhone = ? WHERE alanyaID = ?', [newPhone, alanyaID]);
  await conn.execute(
    `INSERT INTO alanya_phone_history
       (alanyaID, old_phone, new_phone, source, order_id, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [alanyaID, oldPhone, newPhone, source, orderId, changedBy, now],
  );
}

/**
 * Pose le numéro d'une commande sur son compte, la commande verrouillée par
 * l'appelant.
 *
 * Le numéro ne peut être porté par un autre qu'au terme d'une course
 * théorique : une inscription qui le tire au hasard dans la milliseconde
 * entre son contrôle et son INSERT (tous les autres chemins respectent la
 * mise de côté). Le paiement, lui, est acquis : la commande devient un
 * crédit, et l'utilisateur choisit un autre numéro sans repayer. Aucune
 * issue ne laisse un paiement sans contrepartie.
 *
 * @returns {Promise<{ orderId: number, alanyaID: number, phone: string,
 *   oldPhone: string|null, applied: boolean }>}
 */
async function applyOrder(conn, order, now = new Date()) {
  const alanyaID = Number(order.alanyaID);
  const phone = order.phone_canonical;
  const [[user]] = await conn.execute(
    'SELECT alanyaPhone FROM users WHERE alanyaID = ? FOR UPDATE',
    [alanyaID],
  );
  const oldPhone = user?.alanyaPhone ?? null;

  if (oldPhone !== phone) {
    try {
      await recordPhoneChange(conn, {
        alanyaID, oldPhone, newPhone: phone, source: PHONE_CHANGE_SOURCE.PURCHASE, orderId: order.id, now,
      });
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await conn.execute(
        'UPDATE alanya_phone_order SET status = ?, old_phone = ? WHERE id = ?',
        [O.CREDIT, oldPhone, order.id],
      );
      console.error(`[numero] commande ${order.id} : ${phone} porté entre-temps, crédit ouvert pour ${alanyaID}`);
      return { orderId: order.id, alanyaID, phone, oldPhone, applied: false };
    }
  }

  await conn.execute(
    'UPDATE alanya_phone_order SET status = ?, old_phone = ?, applied_at = ? WHERE id = ?',
    [O.APPLIED, oldPhone, now, order.id],
  );
  return { orderId: order.id, alanyaID, phone, oldPhone, applied: true };
}

/**
 * Paiement confirmé : pose le numéro de la commande qui l'attendait.
 *
 * @returns {Promise<object|null>} le résultat d'`applyOrder`, ou null si
 *   aucune commande n'attend ce paiement (confirmation rejouée)
 */
async function applyOrderForPayment(conn, { paymentId, now = new Date() }) {
  const [[order]] = await conn.execute(
    'SELECT * FROM alanya_phone_order WHERE payment_id = ? FOR UPDATE',
    [paymentId],
  );
  if (!order) {
    console.error(`[numero] paiement ${paymentId} confirmé sans commande`);
    return null;
  }
  const status = Number(order.status);
  if (status === O.APPLIED || status === O.CREDIT) return null;
  return applyOrder(conn, order, now);
}

/** Paiement échoué ou expiré : la commande est abandonnée, le numéro redevient libre. */
async function abandonOrderForPayment(conn, { paymentId }) {
  await conn.execute(
    'UPDATE alanya_phone_order SET status = ? WHERE payment_id = ? AND status = ?',
    [O.ABANDONED, paymentId, O.PAYING],
  );
}

module.exports = {
  recordPhoneChange,
  applyOrder,
  applyOrderForPayment,
  abandonOrderForPayment,
};
