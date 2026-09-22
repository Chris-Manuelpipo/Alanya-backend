-- Migration 088 : répondeur v2 — plages par jour, interrupteur « sans réponse », annonce
--
-- Appliquer après 087. Application MANUELLE, comme toutes les autres.
--
-- ⚠ Cette migration N'EST PAS réexécutable telle quelle : les `ADD COLUMN` et
-- `DROP COLUMN` échouent au second passage. C'est voulu — la rendre idempotente
-- demanderait du SQL dynamique sur `information_schema`, illisible pour trois
-- colonnes. En cas de doute, vérifier d'abord :
--
--   SHOW COLUMNS FROM user_voicemail_schedule;
--
-- ── Pourquoi on peut restructurer sans précaution ──
--
-- `user_voicemail_schedule` est VIDE en production : la v1 du répondeur a été
-- déployée côté serveur, mais l'application ne l'a jamais été, et il n'existe
-- aucun autre moyen d'y écrire une ligne. Il n'y a donc aucune donnée à migrer,
-- aucun réglage d'utilisateur à préserver, et les trois colonnes supprimées
-- ci-dessous ne décrivent le créneau de personne.
--
-- ── Ce qui remplace startTime/endTime/daysBitmask ──
--
-- La v1 n'offrait qu'UNE fenêtre appliquée à un ensemble de jours cochés. La v2
-- veut plusieurs périodes PAR JOUR — lundi 12 h-14 h ET 22 h-7 h, mardi 9 h-17 h.
-- Ça ne tient plus dans une ligne : c'est une table. Les trois colonnes
-- disparaissent plutôt que de rester là sans être lues, parce qu'une colonne
-- morte finit toujours par être crue vivante.
--
-- ── `no_answer_enabled` : le troisième mode, et il est d'une autre nature ──
--
-- Les plages et la durée rendent le téléphone MUET : le serveur n'arme rien et
-- n'envoie aucun push, et c'est cette absence qui garantit le silence.
-- `no_answer_enabled` fait l'inverse : le téléphone SONNE, et l'appel bascule
-- au répondeur s'il n'est pas décroché à temps.
--
-- C'est pourquoi il a sa propre colonne et non une valeur d'un `mode` : il se
-- CUMULE avec les deux autres, qui sont exclusifs entre eux. Un réglage courant
-- sera « répondeur si je ne réponds pas, en permanence, ET silence total entre
-- 22 h et 7 h ». Quand les deux s'appliquent, le silence l'emporte — il n'y a
-- pas de sonnerie à laisser expirer.
--
-- Le même interrupteur commande aussi le refus explicite et le « déjà en
-- communication » : trois façons pour un appel d'aboutir alors que le téléphone
-- était joignable.
--
-- ── L'annonce : une URL, et pas d'empreinte ──
--
-- `greeting_url` porte l'adresse publique du fichier, `greeting_seconds` sa
-- durée pour l'affichage. Il n'y a délibérément AUCUNE colonne de hachage.
--
-- Le cache média de l'application indexe par le DERNIER SEGMENT de l'URL, sans
-- aucune invalidation par contenu ni durée de vie. Une annonce servie sous un
-- nom stable serait donc jouée éternellement dans sa première version, même
-- réenregistrée. Le nom de fichier porte un suffixe aléatoire : réenregistrer
-- produit une autre URL, donc une autre entrée de cache, et l'ancien fichier est
-- supprimé. L'empreinte, c'est le nom.

ALTER TABLE user_voicemail_schedule
  ADD COLUMN no_answer_enabled TINYINT NOT NULL DEFAULT 0
    COMMENT '1 = basculer au répondeur si l''appel n''est pas décroché, refusé, ou si la ligne est occupée',
  ADD COLUMN greeting_url VARCHAR(255) NULL
    COMMENT 'Annonce jouée à l''appelant. Le nom du fichier porte un suffixe aléatoire : il fait office d''empreinte pour le cache client.',
  ADD COLUMN greeting_seconds SMALLINT NULL
    COMMENT 'Durée de l''annonce, en secondes. Plafond applicatif : 10.',
  DROP COLUMN startTime,
  DROP COLUMN endTime,
  DROP COLUMN daysBitmask;

-- Plages programmées : une ligne par période et par jour.
--
-- Pas de contrainte d'unicité sur (alanyaID, dayBit, startTime) : deux plages
-- identiques le même jour sont une bêtise, pas une corruption, et le contrôleur
-- plafonne déjà à trois plages par jour. Une contrainte ici ferait échouer une
-- écriture entière pour un doublon sans conséquence.
--
-- ⚠ Une plage dont `endTime <= startTime` FRANCHIT MINUIT et déborde sur le
-- lendemain : (lundi, 22:00, 07:00) couvre lundi 22 h → mardi 7 h. C'est
-- l'interprétation naturelle d'un réglage par jour, et elle diffère de la v1,
-- qui coupait à minuit. L'évaluation doit donc regarder les plages de la VEILLE
-- en plus de celles du jour — c'est le point qu'on oublie.
CREATE TABLE IF NOT EXISTS user_voicemail_slot (
  id        BIGINT  NOT NULL AUTO_INCREMENT,
  alanyaID  INT     NOT NULL,
  dayBit    TINYINT NOT NULL
              COMMENT '0=lundi … 6=dimanche — même convention que user_dnd_schedule (migration 033)',
  startTime TIME    NOT NULL,
  endTime   TIME    NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_slot_owner_day (alanyaID, dayBit),
  CONSTRAINT ck_slot_day CHECK (dayBit BETWEEN 0 AND 6),
  CONSTRAINT fk_slot_owner FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
