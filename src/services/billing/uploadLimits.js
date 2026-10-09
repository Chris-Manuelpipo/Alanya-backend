/**
 * Plafonds d'envoi d'un compte : la taille d'un fichier (et, côté téléphone, le
 * nombre de médias d'un album). Le serveur applique ce que `decideEntitlements`
 * annonce au téléphone (`limits`) — même règle (`isPaidTier`), un seul calcul.
 *
 * Sur le chemin de chaque envoi de média, donc sans lecture quand elle est
 * inutile : hors phase payante, tout le monde est au palier standard (réglages
 * en cache 30 s). Sinon une lecture du compte, retenue au plus une minute et
 * jusqu'à la fin de l'abonnement qui couvre — un abonnement qui finit ne laisse
 * pas passer un fichier de plus de 100 Mo une minute de trop.
 *
 * Une panne de la base donne le palier standard : refuser un fichier de 150 Mo à
 * un abonné le temps d'une panne est un moindre mal que d'en laisser passer un
 * de 200 Mo à qui n'a pas payé.
 */

const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { PHASE } = require('../../constants/billing');
const { getBillingSettings } = require('./settings');
const { effectivePhase, isPaidTier, tierLimits } = require('./rules');
const { loadFacts } = require('./outgoingGate');

const CACHE_MAX_MS = 60_000;
const MAX_ENTRIES = 50_000;

function createUploadLimits({
  getSettings = getBillingSettings,
  loadAccount = loadFacts,
  clock = () => new Date(),
  env = process.env,
} = {}) {
  const cache = new Map();

  async function limitsFor(alanyaID) {
    const now = clock();
    try {
      const phase = effectivePhase(await getSettings(), alanyaID, now, env);
      if (phase !== PHASE.PAID) return tierLimits(false);

      const hit = cache.get(alanyaID);
      if (hit && hit.until > now.getTime()) return hit.limits;

      const facts = await loadAccount(alanyaID, now);
      if (!facts) return tierLimits(false);
      const exempt = Number(facts.type_compte) >= 1
        || Number(facts.account_type) === ACCOUNT_TYPE.OFFICIEL;
      const paid = isPaidTier({
        phase, exempt, coveredUntil: facts.covered_until, now,
      });
      const limits = tierLimits(paid);

      if (cache.size >= MAX_ENTRIES) cache.clear();
      const covered = facts.covered_until ? new Date(facts.covered_until).getTime() : Infinity;
      cache.set(alanyaID, {
        limits,
        until: Math.min(now.getTime() + CACHE_MAX_MS, paid && !exempt ? covered : Infinity),
      });
      return limits;
    } catch (err) {
      console.warn('[upload] plafonds indisponibles, palier standard :', err.code || err.message);
      return tierLimits(false);
    }
  }

  return {
    limitsFor,
    invalidateUploadLimits: (alanyaID) => { cache.delete(Number(alanyaID)); cache.delete(alanyaID); },
    clearUploadLimitsCache: () => cache.clear(),
    cacheSize: () => cache.size,
  };
}

const instance = createUploadLimits();

module.exports = {
  createUploadLimits,
  limitsFor: instance.limitsFor,
  invalidateUploadLimits: instance.invalidateUploadLimits,
  clearUploadLimitsCache: instance.clearUploadLimitsCache,
};
