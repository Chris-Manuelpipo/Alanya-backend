-- Migration 038 : socle compte (account_type, vérification business)
-- Appliquer après 037. Réexécution : ignorer 1060 (Duplicate column).

ALTER TABLE users
  ADD COLUMN account_type TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN verification_status TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN verified_until DATETIME NULL,
  ADD COLUMN verification_reminder_sent TINYINT NOT NULL DEFAULT 0,
  ALGORITHM=INSTANT;

ALTER TABLE users
  ADD INDEX idx_users_account_type (account_type, verification_status),
  ADD INDEX idx_users_verified_until (verified_until),
  ADD INDEX idx_users_verification_status (verification_status, alanyaID),
  ADD INDEX idx_users_last_seen (last_seen, alanyaID);
