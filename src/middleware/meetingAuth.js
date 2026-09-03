const { loadMeetingAccess } = require('../services/meetingAccess');
const { verdictLecture, verdictOrganisateur } = require('../services/meetingAccessRules');

/**
 * Autorisations de réunion, côté HTTP.
 *
 * Ces gardes n'existaient pas : `GET /:id` rendait la fiche complète — noms,
 * pseudos, avatars, présence de chaque participant — à tout compte authentifié,
 * et `DELETE /:id` supprimait les lignes `participant` **avant** de regarder si
 * l'appelant organisait quoi que ce soit. Le contrôle d'organisateur ne portait
 * que sur la seconde requête, celle de la réunion : un tiers ne supprimait donc
 * pas la réunion, mais il en vidait la liste des participants, et la route
 * répondait 200.
 *
 * Posées uniquement sur les routes corrigées. `POST /:id/invite` et
 * `PUT /:id` font déjà leur vérification en ligne : on ne les réécrit pas, pour
 * ne pas mélanger correction de faille et remaniement — même règle que
 * `groupAuth.js`.
 *
 * La décision vit dans `services/meetingAccessRules.js` (pure, testée seule) et
 * le chargement dans `services/meetingAccess.js`, que le handler socket
 * `meeting:join_room` appelle directement : une room n'a pas de middleware.
 *
 * Une seule requête, exposée dans `req.meetingAccess` — le handler n'a pas à la
 * refaire, et y trouve `typeMedia`, `duree` et `startTime`.
 */

/** Traduit un identifiant d'URL, ou null s'il n'est pas exploitable. */
const _idValide = (brut) => {
  const n = parseInt(brut, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
};

/**
 * Exige que l'appelant organise la réunion ou y soit invité.
 *
 * 404 et non 403 : un 403 confirmerait l'existence de la réunion à quelqu'un
 * qui n'a rien à y voir. Le corps est le même que pour une réunion inexistante,
 * sans quoi la route redevient un oracle d'existence.
 */
const requireMeetingParticipant = async (req, res, next) => {
  try {
    const idMeeting = _idValide(req.params.id);
    if (!idMeeting) {
      return res.status(400).json({ error: 'Identifiant de réunion invalide' });
    }
    const acces = await loadMeetingAccess(idMeeting, req.user.alanyaID);
    if (verdictLecture(acces) !== 'ok') {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    req.meetingAccess = acces;
    next();
  } catch (error) {
    // Express 4 : un `throw` dans un handler asynchrone n'atteint pas
    // `errorHandler`. Le relais est explicite, comme dans `groupAuth.js`.
    next(error);
  }
};

/**
 * Exige l'organisateur : terminer, supprimer, admettre, refuser.
 *
 * Composé, pour que l'étranger tombe d'abord sur le 404 du premier maillon.
 * Le 403 n'est atteint que par un membre — là, l'existence n'est plus un
 * secret et l'appelant a droit à la raison.
 */
const requireMeetingOrganiser = [
  requireMeetingParticipant,
  (req, res, next) => {
    if (verdictOrganisateur(req.meetingAccess) !== 'ok') {
      return res.status(403).json({
        error: "Réservé à l'organisateur de la réunion",
        code: 'MEETING_ORGANISER_REQUIRED',
      });
    }
    next();
  },
];

module.exports = { requireMeetingParticipant, requireMeetingOrganiser };
