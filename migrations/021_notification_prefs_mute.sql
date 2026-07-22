-- Préférences notifications globales et mute par conversation (Phase 3)
-- Réexécution : ignorer erreurs "Duplicate column" si déjà appliqué.

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  alanyaID INT NOT NULL PRIMARY KEY,
  messagesEnabled TINYINT NOT NULL DEFAULT 1,
  groupMessagesEnabled TINYINT NOT NULL DEFAULT 1,
  callsEnabled TINYINT NOT NULL DEFAULT 1,
  meetingsEnabled TINYINT NOT NULL DEFAULT 1,
  statusViewEnabled TINYINT NOT NULL DEFAULT 0,
  soundEnabled TINYINT NOT NULL DEFAULT 1,
  vibrationEnabled TINYINT NOT NULL DEFAULT 1,
  previewMode ENUM('full','name_only','generic') NOT NULL DEFAULT 'full',
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_prefs_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Colonnes mute (appliquer une seule fois)
-- ALTER TABLE conv_participants ADD COLUMN mutedUntil DATETIME NULL;
-- ALTER TABLE conv_participants ADD COLUMN mentionsOnly TINYINT NOT NULL DEFAULT 0;
