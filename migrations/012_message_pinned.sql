-- Épinglage de message (par message, visible de tous les participants).
ALTER TABLE message
  ADD COLUMN isPinned TINYINT NOT NULL DEFAULT 0 COMMENT '1 = message épinglé',
  ADD COLUMN pinnedAt DATETIME NULL                COMMENT 'Date du dernier épinglage',
  ADD COLUMN pinnedBy INT      NULL                COMMENT 'alanyaID de l''auteur de l''épinglage';
