-- Média à vue unique (« view once »).
ALTER TABLE message
  ADD COLUMN isViewOnce TINYINT NOT NULL DEFAULT 0 COMMENT '1 = média à vue unique';

-- Suivi des vues par destinataire (une vue unique = une ligne par utilisateur).
CREATE TABLE IF NOT EXISTS message_views (
  msgID    INT      NOT NULL,
  alanyaID INT      NOT NULL,
  viewedAt DATETIME NOT NULL,
  PRIMARY KEY (msgID, alanyaID)
);
