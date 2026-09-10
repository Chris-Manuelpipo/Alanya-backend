const { ACCOUNT_TYPE, VERIFICATION } = require('../constants/accountTypes');

const ACCOUNT_TYPES = Object.values(ACCOUNT_TYPE);
const VERIFICATION_STATUSES = Object.values(VERIFICATION);

/**
 * Entier strict : un nombre entier, ou une chaîne de chiffres. `Number('')`
 * vaut 0 et `Number(true)` vaut 1 — sans ce garde, un champ vide ou un booléen
 * passerait pour « aucune démarche » ou « en cours ».
 */
function toStrictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/**
 * Valide le corps de PUT /admin/users/:id/socle.
 *
 * Fonction pure — ni lecture ni écriture en base — pour être testée sans
 * MySQL. Les règles qui dépendent de l'état du compte (officiel non
 * promouvable, genre d'un administrateur figé) restent dans le contrôleur.
 *
 * Seuls les champs présents dans le corps figurent dans `value` : un champ
 * absent ne doit pas être écrit.
 *
 * @param {object} body
 * @returns {{ ok: true, value: { accountType?: number, verificationStatus?: number, verifiedUntil?: Date|null } }
 *          | { ok: false, code: string, error: string }}
 */
function parseSoclePayload(body) {
  const { account_type, verification_status, verified_until } = body || {};
  const value = {};

  if (account_type != null) {
    const at = toStrictInt(account_type);
    if (!ACCOUNT_TYPES.includes(at)) {
      return { ok: false, code: 'INVALID_ACCOUNT_TYPE', error: 'account_type invalide' };
    }
    value.accountType = at;
  }

  if (verification_status != null) {
    const vs = toStrictInt(verification_status);
    if (!VERIFICATION_STATUSES.includes(vs)) {
      return { ok: false, code: 'INVALID_VERIFICATION_STATUS', error: 'verification_status invalide' };
    }
    value.verificationStatus = vs;
  }

  if (verified_until !== undefined) {
    if (verified_until === null || verified_until === '') {
      value.verifiedUntil = null;
    } else {
      const d = typeof verified_until === 'string' ? new Date(verified_until) : new Date(NaN);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, code: 'INVALID_VERIFIED_UNTIL', error: 'verified_until invalide' };
      }
      // Un objet Date, pas la chaîne reçue : le pool est en UTC
      // (src/config/db.js, timezone 'Z'), mysql2 le sérialise sans décalage.
      value.verifiedUntil = d;
    }
  }

  return { ok: true, value };
}

module.exports = { parseSoclePayload };
