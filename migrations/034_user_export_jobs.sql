-- Migration 034 : export de données utilisateur (phase 2 async avec messages)
-- status : TINYINT (0=pending, 1=processing, 2=ready, 3=failed)
-- Réexécution : CREATE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS user_export_jobs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  alanyaID INT NOT NULL,
  status TINYINT NOT NULL DEFAULT 0 COMMENT '0=pending 1=processing 2=ready 3=failed',
  includeMessages TINYINT NOT NULL DEFAULT 0,
  filePath VARCHAR(512) NULL,
  errorMessage TEXT NULL,
  expiresAt DATETIME NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_export_jobs_user_status (alanyaID, status),
  CONSTRAINT fk_export_jobs_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
