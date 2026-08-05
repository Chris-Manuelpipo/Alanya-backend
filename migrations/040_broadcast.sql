-- Migration 040 : diffusions + livraisons + filigrane utilisateur

CREATE TABLE IF NOT EXISTS broadcast (
  id                           BIGINT       NOT NULL AUTO_INCREMENT,
  sender_id                    INT          NOT NULL,
  created_by                   INT          NOT NULL,
  kind                         TINYINT      NOT NULL DEFAULT 0,
  content                      TEXT         NULL,
  type                         TINYINT      NOT NULL DEFAULT 0,
  media_url                    VARCHAR(255) NULL,
  criteria                     JSON         NOT NULL,
  estimate                     INT          NOT NULL DEFAULT 0,
  client_id                    VARCHAR(64)  NOT NULL,
  status                       ENUM('preparing','queued','running','completed','partial_failed') NOT NULL DEFAULT 'preparing',
  push_jobs_total              INT          NOT NULL DEFAULT 0,
  push_jobs_done               INT          NOT NULL DEFAULT 0,
  push_failed_jobs             INT          NOT NULL DEFAULT 0,
  push_completed_at            DATETIME     NULL,
  delivered_count              INT          NOT NULL DEFAULT 0,
  delivered_count_refreshed_at DATETIME     NULL,
  statut_id                    INT          NULL,
  sent_at                      DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_broadcast_client (client_id),
  KEY idx_broadcast_sent (sent_at),
  KEY idx_broadcast_status (status)
);

CREATE TABLE IF NOT EXISTS broadcast_delivery (
  id           BIGINT   NOT NULL AUTO_INCREMENT,
  broadcast_id BIGINT   NOT NULL,
  alanyaID     INT      NOT NULL,
  conversID    INT      NULL,
  msgID        INT      NULL,
  delivered_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery (broadcast_id, alanyaID),
  KEY idx_delivery_user (alanyaID, broadcast_id),
  CONSTRAINT fk_delivery_broadcast FOREIGN KEY (broadcast_id) REFERENCES broadcast(id) ON DELETE CASCADE
);

ALTER TABLE users
  ADD COLUMN last_broadcast_id BIGINT NOT NULL DEFAULT 0;

ALTER TABLE user_notification_prefs
  ADD COLUMN broadcastsEnabled TINYINT NOT NULL DEFAULT 1;

ALTER TABLE statut
  ADD INDEX idx_statut_expired (expiredAt);
