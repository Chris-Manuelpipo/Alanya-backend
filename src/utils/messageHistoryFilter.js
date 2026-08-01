/**
 * Filtre d'historique de groupe par participant.
 *
 * `conv_participants.historyCutoffAt` est NULL pour un historique complet
 * (défaut, et tous les membres antérieurs à la migration 028). Quand un
 * admin a activé `hideHistoryForNewMembers` au moment de l'ajout, le cutoff
 * est posé à NOW() et seuls les messages `sendAt >= cutoff` sont exposés.
 *
 * `>=` et non `>` : le message système `member_added` écrit à l'ajout doit
 * rester visible pour le nouvel arrivant.
 */

/** Fragment SQL à AND-er. Prérequis : alias `m` (message) et `cp` (participants). */
const HISTORY_CUTOFF_SQL =
  '(cp.historyCutoffAt IS NULL OR m.sendAt >= cp.historyCutoffAt)';

module.exports = { HISTORY_CUTOFF_SQL };
