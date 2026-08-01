-- =============================================================
--  Migration 029 : verrou « seuls les admins ajoutent des membres »
-- =============================================================
--
-- Découple l'ajout de participants de onlyAdminsCanEditInfo :
--   conversation.onlyAdminsCanAddMembers  → défaut OFF (tout le monde peut)
--
-- Réexécution :
--   mysql -u<user> -p <base> --force < 029_only_admins_can_add_members.sql
--
-- Erreurs bénignes au rejeu :
--   1060  Duplicate column name

ALTER TABLE conversation
  ADD COLUMN onlyAdminsCanAddMembers TINYINT NOT NULL DEFAULT 0
      COMMENT '1 = seuls admins/proprio peuvent ajouter des membres';
