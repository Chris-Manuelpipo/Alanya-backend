-- Migration 077 : participant.status veut désormais dire « a rejoint »
--
-- ── Le défaut ──
-- `inviteParticipants` écrivait `status = 1` à l'invitation, avec le
-- commentaire d'intention « participants directement acceptés ». Le badge du
-- détail de réunion (côté application) lisait exactement ce champ et
-- affichait « Accepté » pour tout le monde — y compris pour un invité qui
-- n'avait jamais ouvert l'application.
--
-- ── Le correctif applicatif ──
-- `inviteParticipants` insère désormais en `status = 0` ; le premier join réel
-- (HTTP `POST /:id/join` ou socket `meeting:join_room`) le fait passer à 1.
-- L'organisateur reste à 1 dès la création : il est présent par construction.
--
-- ── Les lignes déjà écrites ──
-- Cette migration corrige les invitations passées, dont le `status = 1` est
-- faux pour quiconque n'est jamais venu. Le seul témoin fiable d'une présence
-- réelle dans les données existantes est `duree > 0` (écrite au départ,
-- src/services/meetingWorkers.js) ou `connecte = 1` (encore en réunion).
--
-- L'erreur résiduelle va dans le sens prudent : quelqu'un qui a assisté sans
-- que sa durée ait été écrite — un plantage avant la cascade de nettoyage,
-- rare avant le correctif de meeting:end (voir la migration précédente) —
-- redevient « En attente ». On ne réaffirme jamais une présence qu'on ne peut
-- pas prouver.
--
-- L'organisateur est explicitement épargné : sa ligne reste à 1 même sans
-- `duree` ni `connecte`, par la même convention que le correctif applicatif.
--
-- ── Rejouabilité ──
-- L'UPDATE ne remonte jamais un 0 vers un 1 : rejouable telle quelle.

UPDATE participant p
  JOIN meeting m ON m.idMeeting = p.idMeeting
   SET p.status = 0
 WHERE p.status = 1
   AND p.IDparticipant <> m.idOrganiser
   AND p.duree = 0
   AND (p.connecte IS NULL OR p.connecte = 0);

-- Le commentaire de la colonne mentait depuis la migration 001.
ALTER TABLE participant
  MODIFY COLUMN status TINYINT NOT NULL DEFAULT 0
    COMMENT '0=invité, jamais rejoint ; 1=a rejoint au moins une fois ; 2=inutilisé';
