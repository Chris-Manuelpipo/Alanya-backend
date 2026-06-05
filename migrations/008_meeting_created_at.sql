-- Migration 008: Ajoute meeting.created_at
-- La table `meeting` de production n'avait pas la colonne created_at (présente
-- dans le schéma initial 001 mais jamais appliquée). Le endpoint admin
-- GET /api/admin/meetings la sélectionne → 500 sans elle.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` : si la colonne existe
-- déjà, ignorer l'erreur 1060 (Duplicate column name) à l'exécution.

ALTER TABLE meeting
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER type_media;

-- Backfill des réunions existantes : aucune vraie date de création n'a jamais
-- été stockée. Meilleur proxy disponible = le plus ancien instant où la réunion
-- a une trace d'existence, soit LEAST(heure planifiée, 1re connexion d'un
-- participant). Pour les réunions instantanées, cela revient à start_time ;
-- pour les réunions planifiées, à la première connexion (souvent peu avant).
UPDATE meeting m
SET created_at = LEAST(
  m.start_time,
  COALESCE((SELECT MIN(p.start_time) FROM participant p WHERE p.idMeeting = m.idMeeting), m.start_time)
);
