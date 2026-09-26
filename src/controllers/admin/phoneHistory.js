/**
 * Les numéros successifs d'un compte, pour le support : « j'ai payé et mon
 * numéro n'a pas changé », « quel était mon ancien numéro ? ».
 */

const pool = require('../../config/db');
const { fail, failInternal } = require('../../utils/apiError');
const { PHONE_CHANGE_SOURCE, PHONE_ORDER_STATUS: O, PHONE_CHANGE } = require('../../constants/billing');

const SOURCE_NAME = Object.freeze({
  [PHONE_CHANGE_SOURCE.PURCHASE]: 'purchase',
  [PHONE_CHANGE_SOURCE.ADMIN]: 'admin',
});

/** GET /admin/users/:id/phone-history */
const getUserPhoneHistory = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 404, 'USER_NOT_FOUND', 'Utilisateur introuvable');
  try {
    const [rows] = await pool.execute(
      `SELECT h.id, h.old_phone, h.new_phone, h.source, h.changed_at,
              u.nom AS changed_by_name, p.amount, p.currency
         FROM alanya_phone_history h
         LEFT JOIN users u ON u.alanyaID = h.changed_by
         LEFT JOIN alanya_phone_order o ON o.id = h.order_id
         LEFT JOIN payment p ON p.id = o.payment_id
        WHERE h.alanyaID = ?
        ORDER BY h.changed_at DESC, h.id DESC
        LIMIT 50`,
      [id],
    );
    // Un changement payé qui attend encore son numéro : c'est la première
    // chose que le support doit voir.
    const [[credit]] = await pool.execute(
      'SELECT id, created_at FROM alanya_phone_order WHERE alanyaID = ? AND status = ? ORDER BY id DESC LIMIT 1',
      [id, O.CREDIT],
    );
    res.json({
      quarantine_days: PHONE_CHANGE.quarantineDays,
      pending_credit: credit ? { order_id: credit.id, created_at: credit.created_at } : null,
      history: rows.map((r) => ({
        id: r.id,
        old_phone: r.old_phone,
        new_phone: r.new_phone,
        source: SOURCE_NAME[Number(r.source)] ?? 'admin',
        changed_at: r.changed_at,
        changed_by_name: r.changed_by_name,
        amount: r.amount != null ? Number(r.amount) : null,
        currency: r.currency ?? null,
      })),
    });
  } catch (err) {
    console.error('[admin/numero] historique :', err);
    return failInternal(res);
  }
};

module.exports = { getUserPhoneHistory };
