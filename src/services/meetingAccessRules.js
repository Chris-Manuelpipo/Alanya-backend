/**
 * Ce qu'un compte a le droit de faire d'une réunion.
 *
 * Aucune entrée/sortie ici — pas même `require('../config/db')` : c'est la
 * décision, et elle se teste seule, sans faux pool ni injection dans
 * `require.cache`. Le chargement vit dans `meetingAccess.js`, les gardes HTTP
 * dans `middleware/meetingAuth.js`, et le handler socket appelle les deux
 * directement (une room n'a pas de middleware Express).
 *
 * Le défaut que ces règles referment : `getMeetingById`, `getMeetingByRoom`,
 * `POST /:id/join`, `DELETE /:id`, `accept/:userId`, `decline/:userId` et
 * `meeting:join_room` ne vérifiaient **rien** — n'importe quel compte
 * authentifié connaissant un `idMeeting` lisait la fiche complète (noms,
 * pseudos, avatars, présence), s'inscrivait, entrait dans la salle et échangeait
 * la signalisation WebRTC. `DELETE /:id` vidait même la table `participant`
 * avant de regarder qui appelait.
 *
 * **404 plutôt que 403 quand on n'est pas membre.** Un 403 confirmerait
 * l'existence de la réunion à quelqu'un qui n'a rien à y voir ; la convention
 * est déjà celle de `middleware/groupAuth.js` et de `tripController`. Le 403
 * n'apparaît qu'un cran plus loin, entre membres : là, l'existence n'est plus un
 * secret, et l'appelant a droit à la raison du refus.
 */

/**
 * L'appelant a-t-il quoi que ce soit à voir avec cette réunion ?
 *
 * L'organisateur compte même sans ligne `participant`. Il en a normalement une
 * — `createMeeting` l'insère — mais faire dépendre son propre accès d'une ligne
 * qu'une purge ou une migration pourrait avoir emportée l'enfermerait dehors de
 * sa propre réunion.
 */
const estMembre = ({ existe, estOrganisateur, estParticipant }) =>
  !!existe && (!!estOrganisateur || !!estParticipant);

/**
 * Lecture d'une fiche de réunion.
 * @returns {'ok'|'introuvable'}
 */
const verdictLecture = (acces) => (estMembre(acces) ? 'ok' : 'introuvable');

/**
 * Geste réservé à l'organisateur : terminer, supprimer, admettre, refuser.
 *
 * L'ordre des deux tests compte. Un inconnu reçoit `introuvable`, jamais
 * `non_organisateur` : ce second code apprendrait que la réunion existe.
 * @returns {'ok'|'introuvable'|'non_organisateur'}
 */
const verdictOrganisateur = (acces) => {
  if (!estMembre(acces)) return 'introuvable';
  return acces.estOrganisateur ? 'ok' : 'non_organisateur';
};

/**
 * Entrée dans une réunion — `POST /:id/join` et `meeting:join_room`.
 *
 * Trois refus, dans cet ordre : ne pas être membre (on ne dit rien), la réunion
 * soldée, l'échéance dépassée. Les deux derniers ne sont dits qu'à un membre :
 * lui apprendre que c'est fini ne lui révèle rien qu'il ne sache déjà.
 *
 * `echue` est calculé **en SQL** par `meetingAccess.js`, pas ici. `start_time`
 * est écrit en UTC par `toMysqlUtc`, et le pilote MySQL rend un `Date`
 * interprété dans le fuseau de la connexion : refaire la comparaison en
 * JavaScript demanderait de trancher cette ambiguïté à chaque appel. Le
 * planificateur compare déjà à `UTC_TIMESTAMP()` côté base ; on fait pareil, et
 * cette règle ne voit plus que des booléens.
 *
 * @returns {'ok'|'introuvable'|'terminee'|'echue'}
 */
const verdictEntree = (acces) => {
  if (!estMembre(acces)) return 'introuvable';
  if (acces.isEnd) return 'terminee';
  if (acces.echue) return 'echue';
  return 'ok';
};

/**
 * Le balayage peut-il solder cette réunion ?
 *
 * **Jamais une réunion vivante.** Un seul participant encore connecté suffit à
 * la protéger, quelle que soit l'heure : une réunion qui déborde de son horaire
 * annoncé est une réunion normale, et la couper en pleine conversation serait un
 * défaut bien pire que celui qu'on corrige.
 *
 * Corollaire assumé : une réunion dont le dernier participant a planté garde
 * `connecte = 1` et ne sera jamais soldée par le balayage. La garde d'entrée la
 * rend inoffensive — plus personne ne peut y entrer. Ne pas « corriger » cet
 * oubli sans avoir d'abord réglé la présence fantôme.
 *
 * `echue` porte déjà la marge appliquée par la requête de candidates ; on le
 * revérifie ici pour que la fonction dise vrai seule, hors de son appelant.
 */
const balayable = ({ isEnd, echue, connectes }) =>
  !isEnd && !!echue && Number(connectes) === 0;

module.exports = {
  estMembre,
  verdictLecture,
  verdictOrganisateur,
  verdictEntree,
  balayable,
};
