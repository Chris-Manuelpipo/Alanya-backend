-- Migration 033 : planification Ne pas déranger
-- daysBitmask : bit0=lundi … bit6=dimanche (127 = tous les jours)
-- Réexécution : CREATE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS user_dnd_schedule (
  alanyaID INT NOT NULL PRIMARY KEY,
  enabled TINYINT NOT NULL DEFAULT 0,
  startTime TIME NOT NULL DEFAULT '22:00:00',
  endTime TIME NOT NULL DEFAULT '07:00:00',
  daysBitmask TINYINT UNSIGNED NOT NULL DEFAULT 127,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_dnd_schedule_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
