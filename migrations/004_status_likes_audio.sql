-- Migration 004: Ajouter le type audio pour les statuts et le système de likes via statut_views

-- Durée du média (audio + vidéo) en millisecondes
ALTER TABLE statut
  ADD COLUMN IF NOT EXISTS mediaDurationMs INT NULL AFTER mediaUrl;

-- Champ "liked" sur statut_views 
ALTER TABLE statut_views
  ADD COLUMN IF NOT EXISTS liked   TINYINT(1) NOT NULL DEFAULT 0 AFTER seenAt,
  ADD COLUMN IF NOT EXISTS likedAt DATETIME   NULL              AFTER liked;

-- Index pour requêtes "qui a liké" / compteurs
ALTER TABLE statut_views
  ADD INDEX IF NOT EXISTS idx_sv_statut_liked (statutID, liked);
