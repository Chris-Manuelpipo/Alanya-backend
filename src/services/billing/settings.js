/**
 * L'interrupteur du payant : lecture en cache court, transitions.
 *
 * Une seule ligne (`billing_settings`, id = 1). Les transitions sont des
 * fonctions distinctes — activer, désactiver, prolonger la grâce — et non une
 * écriture générique : chacune a ses préconditions, et le journal d'audit
 * enregistre un verbe explicite.
 *
 * Annonces aux utilisateurs, fin de grâce et compensation au retour au
 * gratuit arrivent avec les échéances (lot D).
 */

const pool = require('../../config/db');
const { MIN_GRACE_DAYS } = require('../../constants/billing');
const { BillingError } = require('./errors');
const { DAY_MS, phaseAt, activationBlocker, paymentProvider } = require('./rules');

const TTL_MS = 30_000;
let _cache = null;

/** Valeurs de la migration 080, si la ligne manque. */
const DEFAULTS = Object.freeze({
  id: 1,
  paid_enabled: 0,
  activated_at: null,
  grace_until: null,
  deactivated_at: null,
  default_grace_days: 30,
  trial_days: 0,
  retention_days: 30,
  updated_by: null,
  updated_at: null,
});

/**
 * Réglage global, en cache 30 s par instance. Une transition invalide le cache
 * de l'instance qui l'exécute ; les autres voient le changement au plus tard
 * 30 s après — un délai sans conséquence pour un interrupteur qui ouvre une
 * grâce d'au moins sept jours.
 */
async function getBillingSettings() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value;
  const [[row]] = await pool.execute('SELECT * FROM billing_settings WHERE id = 1');
  const value = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateBillingSettings() {
  _cache = null;
}

async function currentPhase(now = new Date()) {
  return phaseAt(await getBillingSettings(), now);
}

/** Exécute `fn(conn, row)` sur la ligne verrouillée, dans une transaction. */
async function withLockedSettings(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute('SELECT * FROM billing_settings WHERE id = 1 FOR UPDATE');
    if (!row) throw new BillingError('BILLING_NOT_CONFIGURED', 503, 'Migration 080 non appliquée');
    const result = await fn(conn, row);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    invalidateBillingSettings();
  }
}

async function updateSettings(patch, adminId) {
  const keys = Object.keys(patch);
  await withLockedSettings(async (conn) => {
    await conn.execute(
      `UPDATE billing_settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE id = 1`,
      [...keys.map((k) => patch[k]), adminId],
    );
  });
  return getBillingSettings();
}

/**
 * Allume le payant : la grâce commence maintenant et dure `graceDays` (par
 * défaut, le réglage), sept jours au moins. Il n'existe pas de passage au
 * payant sans grâce.
 */
async function activate({ graceDays, adminId, now = new Date(), env = process.env }) {
  const blocker = activationBlocker(env);
  if (blocker) {
    throw new BillingError(blocker, 409,
      'Activation refusée : le fournisseur de paiement est le simulateur');
  }
  await withLockedSettings(async (conn, row) => {
    if (Number(row.paid_enabled) === 1) {
      throw new BillingError('BILLING_ALREADY_ACTIVE', 409, 'Le payant est déjà activé');
    }
    const days = graceDays ?? Number(row.default_grace_days);
    if (!Number.isInteger(days) || days < MIN_GRACE_DAYS || days > 365) {
      throw new BillingError('INVALID_GRACE', 400,
        `La grâce dure entre ${MIN_GRACE_DAYS} et 365 jours`);
    }
    await conn.execute(
      `UPDATE billing_settings
          SET paid_enabled = 1, activated_at = ?, grace_until = ?, updated_by = ?
        WHERE id = 1`,
      [now, new Date(now.getTime() + days * DAY_MS), adminId],
    );
  });
  return getBillingSettings();
}

/** Éteint le payant : tout redevient gratuit pour tous. */
async function deactivate({ adminId, now = new Date() }) {
  await withLockedSettings(async (conn, row) => {
    if (Number(row.paid_enabled) !== 1) {
      throw new BillingError('BILLING_NOT_ACTIVE', 409, 'Le payant n\'est pas activé');
    }
    await conn.execute(
      'UPDATE billing_settings SET paid_enabled = 0, deactivated_at = ?, updated_by = ? WHERE id = 1',
      [now, adminId],
    );
  });
  return getBillingSettings();
}

/** Repousse la fin de la grâce. Seulement vers plus tard : une grâce ne se raccourcit pas. */
async function extendGrace({ graceUntil, adminId, now = new Date() }) {
  const target = graceUntil instanceof Date ? graceUntil : new Date(graceUntil);
  if (Number.isNaN(target.getTime())) {
    throw new BillingError('INVALID_GRACE', 400, 'Date de fin de grâce invalide');
  }
  await withLockedSettings(async (conn, row) => {
    if (Number(row.paid_enabled) !== 1) {
      throw new BillingError('BILLING_NOT_ACTIVE', 409, 'Le payant n\'est pas activé');
    }
    const current = row.grace_until ? new Date(row.grace_until) : now;
    if (target <= now || target <= current) {
      throw new BillingError('INVALID_GRACE', 400, 'La nouvelle fin de grâce doit être plus tardive');
    }
    await conn.execute(
      'UPDATE billing_settings SET grace_until = ?, updated_by = ? WHERE id = 1',
      [target, adminId],
    );
  });
  return getBillingSettings();
}

module.exports = {
  getBillingSettings,
  invalidateBillingSettings,
  currentPhase,
  updateSettings,
  activate,
  deactivate,
  extendGrace,
  paymentProvider,
};
