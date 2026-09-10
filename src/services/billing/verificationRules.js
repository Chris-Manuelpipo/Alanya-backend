/**
 * La coche d'un compte, à partir des faits — règle pure, testée sans MySQL
 * (volet 8, « Une seule écriture »). verification.js rassemble les faits et
 * écrit le résultat ; personne d'autre n'écrit `verification_status`.
 */

const { VERIFICATION: V } = require('../../constants/accountTypes');
const { REQUEST_STATUS: R } = require('../../constants/verification');

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
 * @param {object} p
 * @param {object|null} p.request       dernier dossier hors annulés
 * @param {string} p.currentName        nom affiché aujourd'hui
 * @param {object|null} p.entitlements  droits (entitlementsFor), null si indisponibles
 * @returns {{ status: number, until: Date|null }}
 */
function decideVerification({ request, currentName, entitlements }) {
  if (!request) return { status: V.NON_DEMANDE, until: null };
  const status = Number(request.status);
  if (status === R.REVOKED) return { status: V.REVOQUE, until: null };
  if (status === R.REFUSED) return { status: V.REFUSE, until: null };
  if (status !== R.APPROVED) return { status: V.EN_COURS, until: null };
  // Le nom vérifié n'est plus celui qu'on affiche : la coche attend un examen.
  if (nameChanged(request.name_at_approval, currentName)) return { status: V.EN_COURS, until: null };

  // Droits indisponibles (migration absente, base qui hoquette) : on ne retire
  // pas une coche faute de réponse.
  if (!entitlements) return { status: V.VERIFIE, until: null };
  if (!entitlements.features?.verified_badge) return { status: V.EXPIRE, until: null };

  // Phase gratuite ou compte exempté : la coche ne s'arrête pas. Sinon elle
  // suit l'abonnement — ou la grâce, qui la porte jusqu'à sa fin.
  const until = entitlements.phase === 'free' || entitlements.exempt
    ? null
    : latest(entitlements.period?.endsAt, entitlements.phase === 'grace' ? entitlements.graceUntil : null);
  return { status: V.VERIFIE, until };
}

/** Rien à écrire : même statut, même échéance. */
function sameVerification(a, b) {
  if (Number(a.status) !== Number(b.status)) return false;
  const x = toDate(a.until);
  const y = toDate(b.until);
  return (!x && !y) || (Boolean(x && y) && x.getTime() === y.getTime());
}

module.exports = { normalizeName, nameChanged, decideVerification, sameVerification };
