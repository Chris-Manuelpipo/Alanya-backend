-- Migration 035 : planification suppression compte (soft-delete + grâce 7 jours)
-- delete_requested_at : moment de la demande utilisateur
-- delete_scheduled_at : purge définitive prévue (NOW + 7 jours)

ALTER TABLE users
  ADD COLUMN delete_requested_at DATETIME NULL,
  ADD COLUMN delete_scheduled_at DATETIME NULL;
