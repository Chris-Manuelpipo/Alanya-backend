-- Mute par conversation (Phase 3.3)
-- Réexécution : ignorer erreurs "Duplicate column" si déjà appliqué.

ALTER TABLE conv_participants ADD COLUMN mutedUntil DATETIME NULL;
ALTER TABLE conv_participants ADD COLUMN muteForever TINYINT NOT NULL DEFAULT 0;
ALTER TABLE conv_participants ADD COLUMN mentionsOnly TINYINT NOT NULL DEFAULT 0;
