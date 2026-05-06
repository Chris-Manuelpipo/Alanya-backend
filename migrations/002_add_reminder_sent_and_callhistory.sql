-- =============================================================
--  Migration 002: Add reminder_sent to meeting table
--  Date: 2026-04-30
--  Description: Ajoute la colonne reminder_sent pour tracker
--               les notifications de rappel de réunion
-- =============================================================

-- Ajouter la colonne reminder_sent à la table meeting si elle n'existe pas
ALTER TABLE meeting 
ADD COLUMN IF NOT EXISTS reminder_sent TINYINT NOT NULL DEFAULT 0 COMMENT 'Flag=0: reminder not sent | Flag=1: reminder has been sent';

-- Ajouter un index pour optimiser les requêtes sur reminder_sent
ALTER TABLE meeting
ADD INDEX IF NOT EXISTS idx_reminder_sent (reminder_sent, isEnd);
