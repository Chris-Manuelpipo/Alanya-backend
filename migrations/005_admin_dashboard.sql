-- Migration 005: Dashboard d'administration — métadonnées de bannissement + index

-- 1) Date et raison du bannissement
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS exclude_at     DATETIME     NULL AFTER exclus,
  ADD COLUMN IF NOT EXISTS exclude_reason VARCHAR(255) NULL AFTER exclude_at;

-- 2) Index pour les filtres du dashboard (date d'inscription, type de compte, bannis)
ALTER TABLE users
  ADD INDEX IF NOT EXISTS idx_users_created_at  (created_at),
  ADD INDEX IF NOT EXISTS idx_users_type_compte (type_compte),
  ADD INDEX IF NOT EXISTS idx_users_exclus      (exclus);
