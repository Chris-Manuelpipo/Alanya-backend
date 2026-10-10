-- Migration 096 : accusés de réception et de lecture par membre, dans les groupes
--
-- Application manuelle, comme toutes les migrations d'ici, AVANT le déploiement
-- du code qui s'en sert (le code lit ces colonnes sans repli).
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` (cf. migration 026) : si
-- relancée après un premier passage réussi, ignorer l'erreur 1060 (Duplicate
-- column name) sur l'ALTER. La table est créée avec IF NOT EXISTS, et les
-- UPDATE de remplissage ne touchent que les repères encore NULL : rejouables.
--
-- ── À quoi elle sert ──
--
-- En groupe, le serveur ne gardait qu'un statut par message : le premier membre
-- qui lisait le faisait passer à « lu » pour tout le monde. Deux conséquences
-- (signalements du groupe 3GI 2029) :
--   - impossible de savoir qui a lu ou reçu un message (écran « Infos du
--     message » de groupe, à venir) ;
--   - le compteur de non-lus d'un membre disparaissait : les messages qu'il
--     récupérait au retour dans l'app arrivaient déjà « lus » (bug A6).
--
-- Les doubles coches bleues dès le premier lecteur sont GARDÉES (décision
-- produit) : `message.status` ne change pas de sens.
--
-- ── Ce qu'elle ajoute ──
--
-- 1. Un repère par membre (`conv_participants`) : le plus grand msgID reçu et
--    lu, avec l'heure du dernier passage. Il donne le statut d'un message DU
--    POINT DE VUE de chaque membre, en une comparaison.
--
-- 2. Un journal des avancées de ces repères (`conv_receipt_log`) : une ligne
--    seulement quand un repère avance, pas une par message. L'heure à laquelle
--    le membre p a lu le message m vaut
--      MIN(at) WHERE alanyaID = p AND kind = 3 AND upToMsgID >= m.
--    Le repère seul ne suffit pas : il ne garde que l'heure du DERNIER passage.

ALTER TABLE conv_participants
  ADD COLUMN lastDeliveredMsgID BIGINT NULL DEFAULT NULL,
  ADD COLUMN lastDeliveredAt    DATETIME NULL DEFAULT NULL,
  ADD COLUMN lastReadMsgID      BIGINT NULL DEFAULT NULL,
  ADD COLUMN lastReadAt         DATETIME NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS conv_receipt_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversID  BIGINT   NOT NULL,
  alanyaID   INT      NOT NULL,
  kind       TINYINT  NOT NULL COMMENT '2 = reçu, 3 = lu',
  upToMsgID  BIGINT   NOT NULL,
  at         DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_receipt_conv_kind_upto (conversID, kind, upToMsgID),
  KEY idx_receipt_conv_user      (conversID, alanyaID, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Remplissage des repères (groupes seulement) ──
--
-- Le passé n'est pas journalisé : les heures de lecture d'avant la migration
-- sont inconnues (l'écran affichera « lu » sans heure).
--
-- Reçu : tout ce qui est en base est considéré comme reçu.
UPDATE conv_participants cp
JOIN conversation c ON c.conversID = cp.conversID AND c.isGroup = 1
SET cp.lastDeliveredMsgID = (
      SELECT MAX(m.msgID) FROM message m WHERE m.conversationID = cp.conversID
    )
WHERE cp.lastDeliveredMsgID IS NULL;

-- Lu : le repère est calé pour CONSERVER le `unreadCount` actuel de chacun.
-- Sans non-lus, tout est lu.
UPDATE conv_participants cp
JOIN conversation c ON c.conversID = cp.conversID AND c.isGroup = 1
SET cp.lastReadMsgID = (
      SELECT MAX(m.msgID) FROM message m WHERE m.conversationID = cp.conversID
    )
WHERE cp.lastReadMsgID IS NULL
  AND cp.unreadCount = 0;

-- Avec N non-lus : le repère est le (N+1)-ième message entrant le plus récent,
-- de sorte que les N plus récents restent non lus. Moins de N+1 messages
-- entrants : tout reste non lu (repère à 0).
UPDATE conv_participants cp
JOIN (
  SELECT t.cpId, t.msgID
  FROM (
    SELECT cp2.id AS cpId,
           m.msgID,
           cp2.unreadCount AS n,
           ROW_NUMBER() OVER (PARTITION BY cp2.id ORDER BY m.msgID DESC) AS rang
    FROM conv_participants cp2
    JOIN conversation c2 ON c2.conversID = cp2.conversID AND c2.isGroup = 1
    JOIN message m ON m.conversationID = cp2.conversID AND m.senderID <> cp2.alanyaID
    WHERE cp2.lastReadMsgID IS NULL AND cp2.unreadCount > 0
  ) t
  WHERE t.rang = t.n + 1
) repere ON repere.cpId = cp.id
SET cp.lastReadMsgID = repere.msgID;

UPDATE conv_participants cp
JOIN conversation c ON c.conversID = cp.conversID AND c.isGroup = 1
SET cp.lastReadMsgID = 0
WHERE cp.lastReadMsgID IS NULL;

-- Contrôle (lecture seule), à lancer après coup : pour chaque membre d'un groupe,
-- `attendu` (unreadCount) et `calcule` (messages entrants au-dessus du repère)
-- doivent coïncider, sauf quand le groupe compte moins de messages en base que
-- le compteur (messages purgés).
--
-- SELECT cp.conversID, cp.alanyaID, cp.unreadCount AS attendu,
--        (SELECT COUNT(*) FROM message m
--          WHERE m.conversationID = cp.conversID AND m.senderID <> cp.alanyaID
--            AND m.msgID > cp.lastReadMsgID) AS calcule
-- FROM conv_participants cp
-- JOIN conversation c ON c.conversID = cp.conversID AND c.isGroup = 1
-- HAVING attendu <> calcule;
