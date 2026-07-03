-- Migration 013: clientId sur `message`, pour une dédup fiable des retries
--
-- `message:send` n'avait aucune notion d'idempotence : un client qui rejoue
-- un envoi (accusé `message:sent` perdu suite à une reconnexion socket, cas
-- observé en test réel sur réseau mobile le 2026-07-03) crée une seconde
-- ligne identique en base au lieu de récupérer la première — l'expéditeur
-- reste bloqué sur "en cours" pendant qu'un doublon existe potentiellement
-- côté destinataire.
--
-- `clientId` (déjà généré et envoyé par le client à chaque `_emitSend`,
-- format `c_<userId>_<microsecondes>_<rand>`) devient la clé d'idempotence :
-- NULL autorisé (lignes historiques et l'unique appelant REST qui n'en émet
-- pas), mais unique quand présent — MySQL n'applique pas l'unicité entre
-- NULLs.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` : si la colonne existe
-- déjà, ignorer l'erreur 1060 (Duplicate column name) à l'exécution.

USE alanyBD2027;

ALTER TABLE message
  ADD COLUMN clientId VARCHAR(64) NULL AFTER msgID,
  ADD UNIQUE KEY uq_message_clientId (clientId);
