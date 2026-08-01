-- =============================================================
--  Migration 028 : historique masqué + ack « Rester » à l'ajout
-- =============================================================
--
--   1. conversation.hideHistoryForNewMembers  → défaut OFF pour les ajouts
--   2. conv_participants.historyCutoffAt      → NULL = tout l'historique
--   3. conv_participants.pendingJoinMsgID     → msg système en attente d'ack
--
-- Réexécution :
--   mysql -u<user> -p <base> --force < 028_group_history_join_ack.sql
--
-- Erreurs bénignes au rejeu :
--   1060  Duplicate column name

-- ── 1. Réglage groupe ────────────────────────────────────────

ALTER TABLE conversation
  ADD COLUMN hideHistoryForNewMembers TINYINT NOT NULL DEFAULT 0
      COMMENT 'Masquer l''historique pour les membres ajoutés apres activation';

-- ── 2. Borne d'historique par participant ────────────────────
--
-- NULL = historique complet (comportement historique et défaut).
-- Non-NULL = getMessages / sync n'exposent que sendAt >= cutoff.

ALTER TABLE conv_participants
  ADD COLUMN historyCutoffAt DATETIME NULL
      COMMENT 'NULL=historique complet ; sinon sendAt >= cutoff';

-- ── 3. Consentement « Rester » synchronisé multi-appareil ────
--
-- Posé à l'ajout (msgID du member_added). Cleared par POST /ack-join.
-- Le créateur et les membres initiaux restent à NULL.

ALTER TABLE conv_participants
  ADD COLUMN pendingJoinMsgID INT NULL
      COMMENT 'msgID systeme member_added en attente d''ack Rester';
