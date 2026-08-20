-- 057 — Colonnes conversID/msgID désaccordées avec leurs cibles BIGINT
-- (audit scalabilité, palier P1 tranche A). Voir
-- docs/AUDIT_SCALABILITE_2026-08-06.md §2.1. Aucune de ces colonnes n'a de
-- contrainte FK (vérifié par SHOW CREATE TABLE le 07/08/2026) : aucun ordre
-- d'exécution requis entre elles.
--
-- broadcast_delivery.conversID/msgID : migration 040, désaccord avec
--   conversation.conversID / message.msgID (BIGINT).
-- welcome_delivery.conversID : migration 042, même désaccord.
-- trip_watcher.msgID/conversID : migration 051 — n'existait pas encore lors
--   de l'audit du 06/08 ; simples pointeurs cache, pas de FK.
-- conv_participants.pendingJoinMsgID : migration 028, référence un msgID
--   BIGINT sans FK. conv_participants.unreadCount : SMALLINT signé (plafond
--   32 767) depuis la migration 001, peut déborder sur un groupe très actif.
--
-- ⚠️ Vérifier par SHOW CREATE TABLE avant d'exécuter (migrations appliquées
-- à la main, divergences possibles avec la production).

ALTER TABLE broadcast_delivery MODIFY conversID BIGINT UNSIGNED NULL,
                                MODIFY msgID     BIGINT UNSIGNED NULL;

ALTER TABLE welcome_delivery   MODIFY conversID BIGINT UNSIGNED NOT NULL;

ALTER TABLE trip_watcher       MODIFY msgID     BIGINT UNSIGNED NULL,
                                MODIFY conversID BIGINT UNSIGNED NULL;

ALTER TABLE conv_participants  MODIFY pendingJoinMsgID BIGINT UNSIGNED NULL,
                                MODIFY unreadCount      INT UNSIGNED NOT NULL DEFAULT 0;
