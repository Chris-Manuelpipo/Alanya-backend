const { ACCOUNT_TYPE } = require('../constants/accountTypes');

const ACCOUNT_TYPES = Object.values(ACCOUNT_TYPE);

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
 * @returns {{ ok: true, value: { accountType?: number } }
 *          | { ok: false, code: string, error: string }}
 */
function parseSoclePayload(body) {
  const { account_type, verification_status, verified_until } = body || {};
  const value = {};

  // La coche ne se saisit plus : elle suit le dossier d'identité et
  // l'abonnement (src/services/billing/verification.js, seule écriture).
  if (verification_status !== undefined || verified_until !== undefined) {
    return {
      ok: false,
      code: 'FIELD_IMMUTABLE',
      error: 'L\'état de vérification suit le dossier d\'identité et l\'abonnement, il ne se saisit pas',
    };
  }

  if (account_type != null) {
    const at = toStrictInt(account_type);
    if (!ACCOUNT_TYPES.includes(at)) {
      return { ok: false, code: 'INVALID_ACCOUNT_TYPE', error: 'account_type invalide' };
    }
    value.accountType = at;
  }

  return { ok: true, value };
}

module.exports = { parseSoclePayload };
