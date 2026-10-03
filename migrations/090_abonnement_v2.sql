-- Migration 090 : abonnement v2 — essai gratuit, codes d'activation, choix du modèle
--
-- Appliquer après 089. Application MANUELLE, avant le déploiement du code ;
-- réexécutable sans erreur (CREATE TABLE IF NOT EXISTS, colonnes testées dans
-- information_schema, UPDATE conditionnés aux valeurs d'origine).
--
-- ── Ce que cette migration pose ──
--
-- Le modèle (`billing_settings.model`) : 1 = Alanya Plus actuel, 2 = la v2
-- (3 mois gratuits, puis réception seule jusqu'à l'activation d'un code).
-- Le défaut est 1 : appliquer cette migration ne change rien pour personne.
-- Le super-admin bascule depuis l'administration, payant éteint seulement.
--
-- L'essai ne se stocke pas : il se déduit de `users.created_at` et de
-- `billing_settings.trial_days`. Aucune ligne par inscription.
--
-- Les codes d'activation : un code est acheté sur le site, saisi dans l'app, et
-- donne une période (`subscription_period.source = 4`). Il n'est JAMAIS stocké
-- en clair : seul son HMAC l'est, plus les 4 derniers caractères pour le
-- support. Le prix et la durée sont recopiés à l'émission : changer le plan
-- plus tard ne touche aucun code déjà vendu.
--
-- ── Deux pièges déjà rencontrés sur ce schéma ──
--
-- `users.alanyaID` est un INT signé : les clés étrangères qui le visent le sont
-- aussi (erreur 3780 sinon). Et le XAF n'a pas de sous-unité : 1 000 F s'écrit 1000.

-- ── Codes d'activation ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activation_code (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  code_hash       CHAR(64)     NOT NULL COMMENT 'HMAC-SHA256 du code normalisé, hex',
  code_hint       CHAR(4)      NOT NULL COMMENT 'Quatre derniers caractères, pour le support',
  plan_id         INT          NOT NULL,
  duration_months TINYINT      NOT NULL COMMENT 'Durée du plan À L''ÉMISSION',
  amount_paid     INT          NOT NULL DEFAULT 0 COMMENT 'Prix du plan À L''ÉMISSION ; 0 pour un code offert',
  currency        CHAR(3)      NOT NULL DEFAULT 'XAF',
  source          TINYINT      NOT NULL DEFAULT 0 COMMENT '0=site web 1=administration',
  order_ref       VARCHAR(120) NULL COMMENT 'Commande du site : un webhook rejoué n''émet pas deux codes',
  buyer_contact   VARCHAR(255) NULL COMMENT 'E-mail ou téléphone laissé sur le site, pour renvoyer le code',
  label           VARCHAR(120) NULL COMMENT 'Libellé de lot (administration)',
  status          TINYINT      NOT NULL DEFAULT 0 COMMENT '0=disponible 1=utilisé 2=révoqué',
  expires_at      DATETIME     NOT NULL,
  created_by      INT          NULL COMMENT 'Administrateur, pour un code généré à la main',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  redeemed_by     INT          NULL,
  redeemed_at     DATETIME     NULL,
  period_id       BIGINT       NULL COMMENT 'Période créée par le rachat',
  revoked_by      INT          NULL,
  revoked_at      DATETIME     NULL,
  revoke_reason   VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_code_hash (code_hash),
  -- Plusieurs NULL sont admis : seuls les codes du site portent une commande.
  UNIQUE KEY uq_code_order (order_ref),
  KEY idx_code_status (status, expires_at),
  KEY idx_code_redeemer (redeemed_by),
  CONSTRAINT fk_code_plan FOREIGN KEY (plan_id) REFERENCES plan(id),
  CONSTRAINT fk_code_creator FOREIGN KEY (created_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL,
  CONSTRAINT fk_code_redeemer FOREIGN KEY (redeemed_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL,
  CONSTRAINT fk_code_revoker FOREIGN KEY (revoked_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL,
  CONSTRAINT fk_code_period FOREIGN KEY (period_id)
    REFERENCES subscription_period(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Échecs de saisie par compte : 5 en 15 minutes verrouillent 15 minutes. En
-- base et non en mémoire : le compteur survit à un redémarrage et vaut pour
-- toutes les instances.
CREATE TABLE IF NOT EXISTS code_attempt (
  alanyaID     INT         NOT NULL,
  failures     SMALLINT    NOT NULL DEFAULT 0,
  window_start DATETIME    NOT NULL,
  locked_until DATETIME    NULL,
  PRIMARY KEY (alanyaID),
  CONSTRAINT fk_code_attempt_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Une notification de fin d'essai ne part qu'une fois par compte et par type :
-- la clé primaire est la trace durable (un job réussi, lui, est supprimé de la
-- file).
CREATE TABLE IF NOT EXISTS trial_notice (
  alanyaID INT      NOT NULL,
  kind     TINYINT  NOT NULL COMMENT '1=fin dans 7 jours 2=essai terminé',
  sent_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID, kind),
  CONSTRAINT fk_trial_notice_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Réglages : modèle et lien de paiement ────────────────────────────────

SET @has_model := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_settings'
    AND COLUMN_NAME = 'model'
);
SET @sql := IF(@has_model = 0,
  'ALTER TABLE billing_settings
     ADD COLUMN model TINYINT NOT NULL DEFAULT 1
       COMMENT ''1 = Alanya Plus, 2 = essai de 3 mois puis réception seule'' AFTER paid_enabled,
     ADD CONSTRAINT ck_billing_model CHECK (model IN (1, 2))',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_pay_url := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_settings'
    AND COLUMN_NAME = 'pay_url'
);
SET @sql := IF(@has_pay_url = 0,
  'ALTER TABLE billing_settings
     ADD COLUMN pay_url VARCHAR(255) NULL
       COMMENT ''Site de paiement (https). NULL = bouton désactivé dans l''''app'' AFTER retention_days',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Trois mois, pour les nouveaux comptes (essai) comme pour les comptes
-- existants au moment de l'activation (grâce). Sans effet en v1 : l'essai n'y
-- est pas lu, et la grâce par défaut ne joue qu'à la prochaine activation.
UPDATE billing_settings SET trial_days = 90 WHERE id = 1 AND trial_days = 0;
UPDATE billing_settings SET default_grace_days = 90 WHERE id = 1 AND default_grace_days = 30;

-- ---------------------------------------------------------------------------
-- Vérification après application
-- ---------------------------------------------------------------------------
--   SELECT model, paid_enabled, trial_days, default_grace_days, pay_url
--     FROM billing_settings;
--   -- model = 1, paid_enabled inchangé, trial_days = 90, default_grace_days = 90
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = DATABASE()
--      AND table_name IN ('activation_code','code_attempt','trial_notice');
--   -- doit renvoyer les trois
--
-- ---------------------------------------------------------------------------
-- Retour arrière (aucune donnée perdue tant qu'aucun code n'a été émis)
-- ---------------------------------------------------------------------------
--   DROP TABLE IF EXISTS trial_notice;
--   DROP TABLE IF EXISTS code_attempt;
--   DROP TABLE IF EXISTS activation_code;
--   ALTER TABLE billing_settings DROP CONSTRAINT ck_billing_model;
--   ALTER TABLE billing_settings DROP COLUMN model, DROP COLUMN pay_url;
--   UPDATE billing_settings SET trial_days = 0, default_grace_days = 30 WHERE id = 1;
--
