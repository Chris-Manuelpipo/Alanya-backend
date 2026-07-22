-- Réactions emoji sur les messages — stockées en JSON sur la ligne message
-- (une entrée par utilisateur ; un nouvel upsert remplace l'emoji).
-- Format : [{"userID": 123, "emoji": "👍", "reactedAt": "2026-07-22T12:00:00.000Z"}, ...]
ALTER TABLE message
  ADD COLUMN reactions JSON NULL COMMENT 'Réactions emoji agrégées sur ce message';
