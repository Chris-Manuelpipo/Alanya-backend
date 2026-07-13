-- =============================================================
--  Migration 016 : horodatages détaillés (envoyé / livré)
-- =============================================================
-- clickSentAt : instant (horloge EXPÉDITEUR) où il a appuyé sur "Envoyer",
--   avant tout aller-retour réseau. `sendAt` (déjà existant) reste l'instant
--   où le message est effectivement parti (persistance serveur).
-- deliveredAt : instant où le destinataire a reçu le message (`readAt`
--   existe déjà pour la lecture).
--
-- Pas de colonne pour le fuseau horaire : la table `pays` contient déjà
-- `timeZone`/`decalageHoraire` pour chaque utilisateur (via `users.idPays`).
-- Le fuseau horaire affiché dans "Détails du message" (celui de
-- l'expéditeur) est donc obtenu par simple jointure
-- `message → users → pays` au moment de la lecture, sans rien dupliquer
-- sur chaque ligne de message. Voir messageController.js / chat.js.

ALTER TABLE message
  ADD COLUMN clickSentAt DATETIME NULL COMMENT 'Instant (horloge expéditeur) où il a appuyé sur Envoyer' AFTER sendAt;
  -- ADD COLUMN deliveredAt DATETIME NULL COMMENT 'Instant où le destinataire a reçu le message' AFTER readAt;
