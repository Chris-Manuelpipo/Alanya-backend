/**
 * Le repli « dernier appel entre ces deux comptes » de `processRejectCall`.
 *
 * Quand un refus n'identifie aucun appel, le serveur retombe sur une requête
 * `ORDER BY created_at DESC LIMIT 1` et passe ce qu'elle trouve à
 * `status = 2`. C'est un filet légitime pour un client ancien qui ne sait pas
 * envoyer d'identifiant — mais il devient destructeur dès qu'un identifiant a
 * bien été fourni et qu'il ne désigne simplement pas un appel à deux.
 *
 * Le cas se produit à chaque invitation de groupe refusée, application fermée.
 * La poussée `group_call` ne porte aucun `callId` : l'entrée CallKit prend le
 * `roomId`, de la forme `group_<conv>_<ms>`. Le refus part alors sur le chemin
 * 1-à-1 avec cet identifiant, `toInt` n'en tire rien, la garde de refus tardif
 * est sautée faute d'entrée d'état — un invité de groupe n'en a pas —, et le
 * repli sélectionne **le dernier appel à deux** entre l'invitant et l'invité.
 * Un appel parfaitement abouti, parfois vieux de plusieurs jours, passe
 * « Rejeté » chez les DEUX comptes, et `finalizeCallAndNotify` fait remonter
 * leur conversation en tête de liste avec un aperçu daté de maintenant.
 *
 * On corrige ici plutôt que dans la couche cliente, pour la même raison que la
 * garde conférence voisine : le correctif vaut alors pour les versions déjà
 * installées, qui ne changeront pas.
 */

/**
 * Peut-on retomber sur « le dernier appel entre ces deux comptes » ?
 *
 * @param {*} callIdHint l'identifiant fourni par le client, s'il y en a un
 * @returns {boolean} faux dès qu'un identifiant a été fourni sans désigner un
 *   appel à deux — salon de groupe, session de conférence, ou n'importe quoi
 *   d'autre que des chiffres.
 */
function canFallBackToLastCall(callIdHint) {
  const brut = callIdHint == null ? '' : String(callIdHint).trim();
  // Aucun indice : c'est le cas pour lequel le repli a été écrit.
  if (brut === '') return true;
  return /^\d+$/.test(brut);
}

module.exports = { canFallBackToLastCall };
