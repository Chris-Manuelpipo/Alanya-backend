/**
 * Le verrou de l'émission : « ce compte peut-il envoyer un message ou lancer un
 * appel ? ». Recevoir n'est jamais soumis à rien.
 *
 * La règle vit dans rules.js (`outgoingDecision`) : les droits envoyés au
 * téléphone (`features.outgoing`) et ce verrou l'appellent tous deux. Ici, on
 * ne fait que rassembler les faits au meilleur prix — ce verrou se trouve sur
 * le chemin de CHAQUE message envoyé.
 *
 *  - Régime Alanya Plus, payant éteint, grâce : réponse immédiate, sans toucher
 *    la base (les réglages sont en cache 30 s).
 *  - Sinon, une seule lecture (le compte et la période qui le couvre), puis un
 *    cache par compte : un « oui » vaut jusqu'à sa prochaine frontière connue
 *    (fin d'essai, fin de période) et une minute au plus ; un « non » cinq
 *    secondes, pour qu'un code tout juste activé n'attende presque pas.
 *  - Une activation ou un changement de droits vide l'entrée du compte
 *    (`invalidateOutgoing`, appelé par `notifyEntitlementsChanged`).
 *  - En cas de panne de la base, le verrou s'ouvre : il ne ferme jamais faute de
 *    calcul, comme `requireFeature`. La conséquence d'un oui à tort est un
 *    message de plus ; celle d'un non à tort, un compte payant muet.
 */

const pool = require('../../config/db');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { getBillingSettings } = require('./settings');
const { PHASE, BILLING_MODEL } = require('../../constants/billing');
const {
  effectivePhase, outgoingDecision, billingModel, isBillingTester,
} = require('./rules');

const ALLOW_MAX_MS = 60_000;
const DENY_MS = 5_000;
const MAX_ENTRIES = 50_000;

/** Les faits d'un compte, en une requête. */
async function loadFacts(alanyaID, now) {
  const [[row]] = await pool.execute(
    `SELECT u.created_at, u.type_compte, u.account_type,
            (SELECT MAX(sp.ends_at) FROM subscription_period sp
              WHERE sp.alanyaID = u.alanyaID AND sp.starts_at <= ? AND sp.ends_at > ?) AS covered_until
       FROM users u WHERE u.alanyaID = ?`,
    [now, now, alanyaID],
  );
  return row || null;
}

function createOutgoingGate({
  getSettings = getBillingSettings,
  loadAccount = loadFacts,
  clock = () => new Date(),
  env = process.env,
} = {}) {
  const cache = new Map();

  async function checkOutgoing(alanyaID) {
    const now = clock();
    try {
      const settings = await getSettings();
      const phase = effectivePhase(settings, alanyaID, now, env);
      // Régime Alanya Plus, payant éteint, grâce : rien à lire, rien à retenir.
      if (billingModel(settings) !== BILLING_MODEL.TRIAL || phase !== PHASE.PAID) {
        return { allowed: true };
      }
      // Un testeur voit la phase payante sans grâce : sa fin d'essai se calcule
      // comme dans ses droits (entitlements.js), jamais plus tard qu'eux.
      const effective = isBillingTester(alanyaID, env)
        ? { ...settings, paid_enabled: 1, grace_until: null }
        : settings;

      const hit = cache.get(alanyaID);
      if (hit && hit.until > now.getTime()) return { allowed: hit.allowed };

      const facts = await loadAccount(alanyaID, now);
      // Compte introuvable : ce n'est pas à ce verrou d'en décider.
      if (!facts) return { allowed: true };
      const exempt = Number(facts.type_compte) >= 1 || Number(facts.account_type) === ACCOUNT_TYPE.OFFICIEL;
      const decision = outgoingDecision({
        settings: effective,
        phase,
        createdAt: facts.created_at,
        exempt,
        coveredUntil: facts.covered_until,
        now,
      });

      if (cache.size >= MAX_ENTRIES) cache.clear();
      const horizon = decision.allowed
        ? Math.min(now.getTime() + ALLOW_MAX_MS, decision.until ? decision.until.getTime() : Infinity)
        : now.getTime() + DENY_MS;
      cache.set(alanyaID, { allowed: decision.allowed, until: horizon });
      return { allowed: decision.allowed };
    } catch (err) {
      console.warn('[outgoing] verrou indisponible, ouvert :', err.code || err.message);
      return { allowed: true };
    }
  }

  return {
    checkOutgoing,
    invalidateOutgoing: (alanyaID) => { cache.delete(Number(alanyaID)); cache.delete(alanyaID); },
    clearOutgoingCache: () => cache.clear(),
    cacheSize: () => cache.size,
  };
}

const gate = createOutgoingGate();

/** Ce que le client reçoit pour un refus : le code que son panneau d'offre attend. */
const OUTGOING_DENIED = Object.freeze({
  code: 'SUBSCRIPTION_REQUIRED',
  feature: 'outgoing',
  message: 'Envoyer et appeler sont réservés aux abonnés',
});

module.exports = {
  createOutgoingGate,
  checkOutgoing: gate.checkOutgoing,
  invalidateOutgoing: gate.invalidateOutgoing,
  clearOutgoingCache: gate.clearOutgoingCache,
  OUTGOING_DENIED,
};
