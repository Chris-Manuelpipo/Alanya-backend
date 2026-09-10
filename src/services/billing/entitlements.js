/**
 * Droits d'accès d'un compte : la seule fonction qui répond à « cet
 * utilisateur a-t-il droit à cette fonctionnalité ? ». Aucun écran, aucune
 * route ne recalcule la règle de son côté — elle vit dans rules.js
 * (`decideEntitlements`), ici on ne fait que rassembler les faits.
 */

const pool = require('../../config/db');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { getBillingSettings } = require('./settings');
const { listFeatures, featuresOfPlan } = require('./catalog');
const { decideEntitlements, isBillingTester } = require('./rules');

/**
 * @param {number} alanyaID
 * @param {Date} [now]
 * @returns {Promise<object>} la charge utile `entitlements` (volet 8, §Droits d'accès)
 */
async function entitlementsFor(alanyaID, now = new Date()) {
  const [settings, catalog] = await Promise.all([getBillingSettings(), listFeatures()]);
  // Un compte testeur voit la phase payante même interrupteur éteint.
  const tester = isBillingTester(alanyaID);
  const effective = tester ? { ...settings, paid_enabled: 1, grace_until: null } : settings;

  const [[user]] = await pool.execute(
    'SELECT type_compte, account_type FROM users WHERE alanyaID = ?',
    [alanyaID],
  );
  // L'équipe et le compte officiel ne sont jamais soumis à l'offre.
  const exempt = Boolean(user) && (
    Number(user.type_compte) >= 1 || Number(user.account_type) === ACCOUNT_TYPE.OFFICIEL
  );

  const [periods] = await pool.execute(
    `SELECT sp.plan_id, p.code AS plan_code, sp.starts_at, sp.ends_at, sp.source
       FROM subscription_period sp
       JOIN plan p ON p.id = sp.plan_id
      WHERE sp.alanyaID = ? AND sp.ends_at > ?
      ORDER BY sp.starts_at ASC
      LIMIT 24`,
    [alanyaID, now],
  );

  const current = periods.find((p) => new Date(p.starts_at) <= now);
  const planFeatures = current ? await featuresOfPlan(current.plan_id) : [];

  const [[sub]] = await pool.execute(
    'SELECT auto_renew, current_end FROM subscriber WHERE alanyaID = ?',
    [alanyaID],
  );

  const decided = decideEntitlements({
    settings: effective,
    periods,
    catalog,
    planFeatures,
    exempt,
    autoRenew: Number(sub?.auto_renew) === 1,
    lastEnd: sub?.current_end ?? null,
    now,
  });
  return { ...decided, tester };
}

/**
 * Variante tolérante pour les réponses qui ne doivent jamais échouer à cause
 * de l'offre (/auth/me) : sans la migration 080, ou si la base hoquette, les
 * droits sont simplement absents — et l'application considère alors que tout
 * est permis. L'ordre de déploiement serveur / migration / app devient
 * indifférent.
 */
async function entitlementsOrNull(alanyaID, now = new Date()) {
  try {
    return await entitlementsFor(alanyaID, now);
  } catch (err) {
    console.warn('[billing] droits indisponibles :', err.code || err.message);
    return null;
  }
}

module.exports = { entitlementsFor, entitlementsOrNull };
