-- Migration 082 : plan annuel unique, coche adossée à l'abonnement
--
-- Appliquer après 081. Application manuelle ; réexécutable sans erreur.
--
-- ── Ce que cette migration change ──
--
-- L'offre passe à un seul plan actif : l'annuel, à 1000 XAF. Le mensuel
-- reste en base (historique des paiements) mais n'est plus proposé.
--
-- La coche cesse de dépendre d'un dossier d'identité pour les comptes
-- personnels : elle suit l'abonnement. `grants_badge` dit si une période
-- (offerte notamment) la porte ; `badge_revocation` permet à l'admin de
-- la retirer sans toucher aux fonctionnalités payées.

-- ── Tarif ────────────────────────────────────────────────────────────────

UPDATE plan SET price_amount = 1000, is_featured = 1 WHERE code = 'plus_annuel';
UPDATE plan SET is_active = 0 WHERE code = 'plus_mensuel';

-- Les renouvellements automatiques pointant vers le mensuel (désormais
-- inactif) échoueraient en silence : initiateRenewal exige is_active = 1.
UPDATE subscriber s
  JOIN plan mensuel ON mensuel.id = s.renew_plan_id AND mensuel.code = 'plus_mensuel'
  JOIN plan annuel  ON annuel.code = 'plus_annuel'
   SET s.renew_plan_id = annuel.id;

-- Description de la coche au catalogue : plus « après vérification ».
UPDATE feature
   SET description_i18n = JSON_OBJECT(
     'fr', 'Incluse avec votre abonnement',
     'en', 'Included with your subscription',
     'zh', '随订阅附带'
   )
 WHERE code = 'verified_badge';

-- ── grants_badge sur subscription_period ─────────────────────────────────

SET @has_grants_badge := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscription_period'
    AND COLUMN_NAME = 'grants_badge'
);
SET @sql := IF(@has_grants_badge = 0,
  'ALTER TABLE subscription_period ADD COLUMN grants_badge TINYINT NOT NULL DEFAULT 1
     COMMENT ''1 = cette période accorde la coche (défaut pour les paiements)''
     AFTER source',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Révocation de la coche ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS badge_revocation (
  alanyaID   INT          NOT NULL,
  revoked_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by INT          NULL COMMENT 'Administrateur qui a révoqué',
  reason     VARCHAR(255) NOT NULL,
  PRIMARY KEY (alanyaID),
  CONSTRAINT fk_badge_rev_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_badge_rev_admin FOREIGN KEY (revoked_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Vérification après application
-- ---------------------------------------------------------------------------
--   SELECT code, price_amount, is_active, is_featured FROM plan
--    WHERE code IN ('plus_annuel','plus_mensuel');
--   -- plus_annuel : 1000, actif, featured ; plus_mensuel : inactif
--   SELECT COUNT(*) FROM information_schema.COLUMNS
--    WHERE table_schema = DATABASE() AND table_name = 'subscription_period'
--      AND column_name = 'grants_badge';
--   -- doit renvoyer 1
--   SELECT COUNT(*) FROM information_schema.tables
--    WHERE table_schema = DATABASE() AND table_name = 'badge_revocation';
--   -- doit renvoyer 1
--   SELECT COUNT(*) FROM subscriber s
--     JOIN plan p ON p.id = s.renew_plan_id AND p.code = 'plus_mensuel';
--   -- doit renvoyer 0
--
-- ---------------------------------------------------------------------------
-- Retour arrière
-- ---------------------------------------------------------------------------
--   UPDATE plan SET price_amount = 2000 WHERE code = 'plus_annuel';
--   UPDATE plan SET is_active = 1 WHERE code = 'plus_mensuel';
--   ALTER TABLE subscription_period DROP COLUMN grants_badge;
--   DROP TABLE IF EXISTS badge_revocation;
--
