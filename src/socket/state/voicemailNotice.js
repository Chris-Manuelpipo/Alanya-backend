// Plafond du rappel « votre répondeur est actif » : une notification par
// utilisateur et par journée civile, pas une par appel intercepté.
//
// Pourquoi un plafond. Quand un appel tombe sur le répondeur, le destinataire
// est déjà prévenu deux fois : l'entrée apparaît dans son journal d'appels
// (`call_log_updated`), et si l'appelant laisse un vocal, il reçoit la
// notification de message ordinaire. La notification ajoutée ici n'est pas
// « on a essayé de vous appeler » — ce serait du bruit — mais « attention,
// votre répondeur tourne ». Répétée à chaque appel, elle deviendrait
// exactement le bruit qu'elle prétend éviter.
//
// Pourquoi ici et pas une colonne en base. C'est un compteur éphémère qui
// s'oublie tout seul : le TTL fait le ménage, là où une colonne `lastNoticeAt`
// imposerait une écriture MySQL à chaque appel intercepté et une logique de
// remise à zéro quotidienne à écrire et à surveiller.
//
// Deux implémentations, comme le reste de `socket/state` : Redis si REDIS_URL
// est configuré (plafond partagé entre les instances pm2 — sans quoi deux
// instances enverraient deux notifications le même jour), sinon repli sur une
// Map locale au process. Le choix se fait à CHAQUE appel via getDataClient(),
// jamais figé au chargement du module : la connexion Redis s'établit après le
// require.

const { getDataClient } = require('../../config/redisData');

// Deux jours : une journée civile peut durer jusqu'à 25 heures selon le
// fuseau et le changement d'heure, et une clé qui expire trop tôt rouvrirait
// le droit à une seconde notification le même jour.
const TTL_SECONDS = 48 * 60 * 60;

const keyOf = (alanyaID, dayKey) => `alanya:voicemailNotice:${Number(alanyaID)}:${dayKey}`;

// ── Repli mémoire (clé -> expiresAt) ────────────────────────────────────────

const _vues = new Map();

// Expiration paresseuse, comme `pendingCalls` : pas de setInterval, une entrée
// périmée disparaît à la première lecture qui la rencontre. Le balayage borné
// évite qu'un process mono-instance de longue durée n'accumule une entrée par
// utilisateur et par jour indéfiniment.
const SWEEP_PER_CLAIM = 20;

function _sweep(now) {
  let vus = 0;
  for (const [cle, expiresAt] of _vues) {
    if (vus++ >= SWEEP_PER_CLAIM) break;
    if (now > expiresAt) _vues.delete(cle);
  }
}

// ── API publique ────────────────────────────────────────────────────────────

/**
 * Réserve le droit de notifier pour cette journée.
 *
 * @returns {Promise<boolean>} vrai si c'était le premier appel intercepté de
 *   la journée pour ce compte — donc s'il faut notifier. Faux ensuite.
 *
 * La vérification et la réservation sont UNE SEULE opération (`SET NX`) : deux
 * appels simultanés sur deux instances ne doivent pas se croire tous les deux
 * les premiers.
 */
async function claimDailyNotice(alanyaID, dayKey) {
  if (alanyaID == null || !dayKey) return false;
  const cle = keyOf(alanyaID, dayKey);

  const client = getDataClient();
  if (client) {
    const pose = await client.set(cle, '1', { NX: true, EX: TTL_SECONDS });
    return pose === 'OK';
  }

  const now = Date.now();
  _sweep(now);
  const expiresAt = _vues.get(cle);
  if (expiresAt != null && now <= expiresAt) return false;
  _vues.set(cle, now + TTL_SECONDS * 1000);
  return true;
}

/** Remise à zéro — tests uniquement. */
function _resetMemory() {
  _vues.clear();
}

module.exports = {
  TTL_SECONDS,
  keyOf,
  claimDailyNotice,
  _resetMemory,
};
