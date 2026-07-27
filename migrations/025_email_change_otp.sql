-- OTP dédié au changement / ajout d'email (séparé du reset mot de passe).
ALTER TABLE users
  ADD COLUMN pending_email VARCHAR(255) NULL,
  ADD COLUMN email_change_otp VARCHAR(6) NULL,
  ADD COLUMN email_change_otp_expires_at DATETIME NULL;
