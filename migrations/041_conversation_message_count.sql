-- Migration 041 : dénormalisation message_count sur conversation

ALTER TABLE conversation
  ADD COLUMN message_count INT NOT NULL DEFAULT 0;

UPDATE conversation c
SET message_count = (
  SELECT COUNT(*) FROM message m
  WHERE m.conversationID = c.conversID AND m.isDeleted = 0
);
