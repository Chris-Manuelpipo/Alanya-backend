-- Migration 010: Reserved Alanya phone numbers (super-admin assignable)

CREATE TABLE IF NOT EXISTS reserved_alanya_phone (
  id              INT          NOT NULL AUTO_INCREMENT,
  phone_canonical VARCHAR(8)   NOT NULL,
  label           VARCHAR(100) NOT NULL,
  created_by      INT          NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reserved_phone (phone_canonical),
  CONSTRAINT fk_reserved_created_by FOREIGN KEY (created_by) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO reserved_alanya_phone (phone_canonical, label) VALUES
  ('000',       'Numéro réservé 3 chiffres'),
  ('0000',      'Numéro réservé 4 chiffres'),
  ('00000000',  'Numéro réservé 8 chiffres')
ON DUPLICATE KEY UPDATE label = VALUES(label);
