-- Migration 088 : répondeur v2 — plages par jour, interrupteur « sans réponse », annonce
--
-- Appliquer après 087. Application MANUELLE, comme toutes les autres.
--
-- ⚠ NON réexécutable : les `ADD COLUMN` / `DROP COLUMN` échouent au second
-- passage. La rendre idempotente demanderait du SQL dynamique sur
-- `information_schema`, illisible pour trois colonnes. En cas de doute :
--
--   SHOW COLUMNS FROM user_voicemail_schedule;
--
-- ⚠ L'ORDRE DES TROIS INSTRUCTIONS COMPTE. La table des plages est créée, puis
-- REMPLIE depuis l'ancienne forme, et seulement ensuite les colonnes d'origine
-- disparaissent. Les intervertir perdrait les réglages existants.
--
-- ── Il Y A des données, et elles sont converties ──
--
-- Cette migration a d'abord été écrite en supposant la table vide — la v1 du
-- répondeur avait été déployée côté serveur sans que l'application ne le soit.
-- C'était vrai la veille, et faux le lendemain : trois comptes avaient réglé un
-- créneau depuis une version de développement, dont deux règles ACTIVES.
--
-- Supprimer les colonnes sans rien faire aurait donc silencieusement désactivé
-- le répondeur de ces comptes, sans le moindre message. C'est le genre de perte
-- qu'on ne découvre que par une plainte, des semaines plus tard.
--
-- Seules les lignes `enabled = 1` sont converties. Une ligne éteinte ne porte
-- pas un réglage mais les valeurs par défaut du schéma (22 h–7 h, tous les
-- jours) : en faire sept plages donnerait à son propriétaire un calendrier
-- qu'il n'a jamais composé.
--
-- Nuance de sémantique, assumée : la v1 coupait une fenêtre à minuit, la v2 la
-- fait déborder sur le lendemain. Une fenêtre 22 h–7 h réglée du lundi au
-- vendredi couvrira donc désormais le samedi matin. C'est le comportement
-- demandé pour les plages par jour, et il vaut mieux que l'ancien.
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
-- produit une autre URL, donc une autre entrée de cache, et l'ancien fichier
-- est supprimé. L'empreinte, c'est le nom.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. La table des plages
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Pas de contrainte d'unicité sur (alanyaID, dayBit, startTime) : deux plages
-- identiques le même jour sont une bêtise, pas une corruption, et le contrôleur
-- plafonne déjà à trois plages par jour. Une contrainte ici ferait échouer une
-- écriture entière pour un doublon sans conséquence.
--
-- ⚠ Une plage dont `endTime < startTime` FRANCHIT MINUIT et déborde sur le
-- lendemain : (lundi, 22:00, 07:00) couvre lundi 22 h → mardi 7 h. L'évaluation
-- doit donc regarder les plages de la VEILLE en plus de celles du jour — c'est
-- le point qu'on oublie. `endTime = startTime` vaut la journée entière.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Conversion des créneaux existants — AVANT de supprimer les colonnes
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Une ligne par bit allumé du masque. La table dérivée de sept entiers remplace
-- une boucle applicative : le déploiement n'a qu'un fichier SQL à jouer, et
-- personne n'a à se souvenir de lancer un script en plus.
INSERT INTO user_voicemail_slot (alanyaID, dayBit, startTime, endTime)
SELECT v.alanyaID, d.bit, v.startTime, v.endTime
  FROM user_voicemail_schedule v
  JOIN (
        SELECT 0 AS bit UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
  UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
       ) d ON (v.daysBitmask & (1 << d.bit)) <> 0
 WHERE v.enabled = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Les colonnes — EN DERNIER
-- ─────────────────────────────────────────────────────────────────────────────

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
