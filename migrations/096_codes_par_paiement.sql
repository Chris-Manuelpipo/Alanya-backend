-- 096 — Nombre de codes d'activation remis pour un paiement.
--
-- Un paiement sur le site donne `codes_per_payment` codes (3 par défaut) : le
-- payeur garde le sien et offre les autres à ses proches. Réglable dans le
-- backoffice (PUT /admin/billing/settings) ; ne touche aucun code déjà émis.
--
-- Idempotente : peut être rejouée.

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_settings'
    AND COLUMN_NAME = 'codes_per_payment'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE billing_settings
     ADD COLUMN codes_per_payment TINYINT NOT NULL DEFAULT 3
       COMMENT ''Codes d''''activation remis pour un paiement sur le site (1 à 10)'' AFTER pay_url,
     ADD CONSTRAINT ck_codes_per_payment CHECK (codes_per_payment BETWEEN 1 AND 10)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Retour arrière :
--   ALTER TABLE billing_settings DROP CONSTRAINT ck_codes_per_payment;
--   ALTER TABLE billing_settings DROP COLUMN codes_per_payment;
