-- Migration 032 : préférences applicatives (sync multi-appareil)
-- themeMode : TINYINT (0=system, 1=light, 2=dark)
-- Réexécution : CREATE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS user_settings (
  alanyaID INT NOT NULL PRIMARY KEY,
  themeMode TINYINT NOT NULL DEFAULT 0 COMMENT '0=system 1=light 2=dark',
  locale VARCHAR(16) NOT NULL DEFAULT 'fr',
  playbackSpeedVoice DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  playbackSpeedVideo DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  playbackSpeedMusic DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  reduceMotion TINYINT NOT NULL DEFAULT 0,
  fontScale DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_settings_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
