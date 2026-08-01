-- Migration 030 : bio utilisateur (profil public)
-- Réexécution : ignorer erreur 1060 Duplicate column name

ALTER TABLE users
  ADD COLUMN bio VARCHAR(500) NULL;
