-- Migration 031 : préférences de confidentialité
-- Visibilité / preview : TINYINT (0=everyone/full, 1=contacts/name_only, 2=nobody/generic)
-- Réexécution : CREATE IF NOT EXISTS ; INSERT idempotent via ON DUPLICATE KEY

CREATE TABLE IF NOT EXISTS user_privacy_prefs (
  alanyaID INT NOT NULL PRIMARY KEY,
  lastSeenVisibility TINYINT NOT NULL DEFAULT 0 COMMENT '0=everyone 1=contacts 2=nobody',
  onlineVisibility TINYINT NOT NULL DEFAULT 0 COMMENT '0=everyone 1=contacts 2=nobody',
  readReceiptsEnabled TINYINT NOT NULL DEFAULT 1,
  profilePhotoVisibility TINYINT NOT NULL DEFAULT 0 COMMENT '0=everyone 1=contacts 2=nobody',
  addMePolicy TINYINT NOT NULL DEFAULT 0 COMMENT '0=everyone 1=contacts 2=nobody',
  previewMode TINYINT NOT NULL DEFAULT 0 COMMENT '0=full 1=name_only 2=generic',
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_privacy_prefs_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Copie previewMode depuis user_notification_prefs (ENUM string → int)
INSERT INTO user_privacy_prefs (alanyaID, previewMode)
SELECT alanyaID,
  CASE previewMode
    WHEN 'name_only' THEN 1
    WHEN 'generic' THEN 2
    ELSE 0
  END
FROM user_notification_prefs
ON DUPLICATE KEY UPDATE
  previewMode = VALUES(previewMode);
