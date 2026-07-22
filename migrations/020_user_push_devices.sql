-- Migration idempotente : registre push multi-appareil (Phase 2.1)
-- Conserve users.fcm_token / users.device_ID comme fallback legacy.

CREATE TABLE IF NOT EXISTS user_push_devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  alanyaID INT NOT NULL,
  deviceId VARCHAR(128) NOT NULL,
  platform ENUM('android','ios','web','unknown') NOT NULL DEFAULT 'unknown',
  fcmToken VARCHAR(2048) NULL,
  voipToken VARCHAR(2048) NULL,
  locale VARCHAR(16) NULL,
  notificationsEnabled TINYINT NOT NULL DEFAULT 1,
  appState ENUM('foreground','background','unknown') NOT NULL DEFAULT 'unknown',
  activeConversationId BIGINT NULL,
  lastHeartbeatAt DATETIME NULL,
  tokenUpdatedAt DATETIME NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_device_user_device (alanyaID, deviceId),
  KEY idx_push_device_user_enabled (alanyaID, notificationsEnabled),
  KEY idx_push_device_token (fcmToken(191)),
  CONSTRAINT fk_push_device_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
