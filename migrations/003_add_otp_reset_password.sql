-- Migration 003: Ajouter les colonnes pour le reset password sécurisé (OTP)

-- Note: Email est déjà utilisé dans le register, cette colonne peut déjà exister
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL COMMENT 'Email pour authentication et reset password';
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_otp VARCHAR(6) NULL COMMENT 'OTP de 6 chiffres pour reset password';
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_otp_expires_at DATETIME NULL COMMENT 'Expiration de l\'OTP (10 minutes)';

-- Ajouter un index unique sur email pour la recherche rapide
ALTER TABLE users ADD UNIQUE KEY IF NOT EXISTS uq_email (email);
