ALTER TABLE message
  ADD COLUMN isForwarded TINYINT NOT NULL DEFAULT 0
  COMMENT '1 = message transféré';
