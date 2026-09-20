/**
 * La coche d'un compte personnel, à partir des faits — règle pure, testée
 * sans MySQL. verification.js rassemble les faits et écrit le résultat ;
 * personne d'autre n'écrit `verification_status`.
 *
 * Pour les comptes personnels, la coche suit l'abonnement (et non plus un
 * dossier d'identité). Les dossiers restent disponibles pour les comptes
 * business, plus tard ; normalizeName / nameChanged leur serviront.
 */

const { VERIFICATION: V, ACCOUNT_TYPE } = require('../../constants/accountTypes');

const toDate = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Deux noms sont « le même » à la casse, aux espaces et à la forme Unicode
 * près : « Marie  Kouassi » et « marie kouassi » ne justifient pas un nouvel
 * examen, « Marie Kouassi-Diallo » si.
 */
function normalizeName(name) {
  return String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr');
}

function nameChanged(approvedName, currentName) {
  return normalizeName(approvedName) !== normalizeName(currentName);
}

/** La plus tardive des dates données (les nulles ignorées). */
function latest(...dates) {
  const valid = dates.map(toDate).filter(Boolean);
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

/**
 * Fin de la chaîne contiguë de périodes qui accordent la coche, à partir
 * de `now` (période en cours ou première à venir).
 *
 * @param {Array<{starts_at, ends_at}>} grantingPeriods  grants_badge = 1, ends_at > now
 */
function badgeChainEnd(grantingPeriods, now = new Date()) {
  const sorted = [...(grantingPeriods || [])]
    .map((p) => ({ s: toDate(p.starts_at), e: toDate(p.ends_at) }))
    .filter((p) => p.s && p.e && p.e > now)
    .sort((a, b) => a.s - b.s);
  if (!sorted.length) return null;

  const current = sorted.find((p) => p.s <= now);
  const start = current || sorted[0];
  let end = start.e;
  for (const p of sorted) {
    if (p.s <= end && p.e > end) end = p.e;
  }
  return end;
}

/**
 * @param {object} p
 * @param {boolean} p.revoked              ligne dans badge_revocation
 * @param {number}  p.accountType          users.account_type
 * @param {number}  [p.typeCompte]         users.type_compte (≥1 = équipe)
 * @param {string}  p.phase                free | grace | paid
 * @param {Array}   [p.grantingPeriods]    périodes grants_badge=1 finissant après now
 * @param {Date|string|null} [p.lastEnd]   subscriber.current_end (échéance passée)
 * @param {Date}    [p.now]
 * @returns {{ status: number, until: Date|null }|null}
 *   null = ne pas écrire (équipe, business, officiel : badges ailleurs)
 */
function decideBadge({
  revoked = false,
  accountType = ACCOUNT_TYPE.PERSONNEL,
  typeCompte = 0,
  phase = 'free',
  grantingPeriods = [],
  lastEnd = null,
  now = new Date(),
}) {
  if (revoked) return { status: V.REVOQUE, until: null };
  // Équipe, business, officiel : pas de coche indigo automatique.
  if (Number(accountType) !== ACCOUNT_TYPE.PERSONNEL || Number(typeCompte) >= 1) {
    return null;
  }

  if (phase === 'free') return { status: V.NON_DEMANDE, until: null };

  const until = badgeChainEnd(grantingPeriods, now);
  if (until) return { status: V.VERIFIE, until };

  const ended = toDate(lastEnd);
  if (ended && ended <= now) return { status: V.EXPIRE, until: null };
  return { status: V.NON_DEMANDE, until: null };
}

/** Alias conservé pour les appels qui n'ont pas encore basculé. */
const decideVerification = decideBadge;

/** Rien à écrire : même statut, même échéance. */
function sameVerification(a, b) {
  if (a == null || b == null) return a === b;
  if (Number(a.status) !== Number(b.status)) return false;
  const x = toDate(a.until);
  const y = toDate(b.until);
  return (!x && !y) || (Boolean(x && y) && x.getTime() === y.getTime());
}

module.exports = {
  normalizeName,
  nameChanged,
  latest,
  badgeChainEnd,
  decideBadge,
  decideVerification,
  sameVerification,
};
