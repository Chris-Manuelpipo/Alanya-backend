-- Migration 009: Schéma E2EE (Double Ratchet + X3DH, voir ARCHITECTURE.md / IMPLEMENTATION.md)
--
-- Périmètre : conversations 1-à-1 uniquement (isGroup = 0). Le chiffrement de
-- groupe (sender keys) n'est pas couvert par cette migration.
--
-- Le serveur reste zero-knowledge : il ne stocke et ne route que des clés
-- publiques et des blobs opaques (ciphertext / archive_blob). Aucune clé
-- privée ni mot de passe en clair ne transite ici.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` : si la colonne existe
-- déjà, ignorer l'erreur 1060 (Duplicate column name) à l'exécution.

USE talky;

-- =============================================================
--  1. USERS — vault_salt (sel de dérivation de la clé de coffre)
-- =============================================================
-- Le vault_salt n'est pas secret : seul le mot de passe l'est. Il est généré
-- côté serveur à l'inscription et renvoyé au client pour dériver la clé de
-- coffre (Argon2id) qui ne quitte jamais l'appareil.
ALTER TABLE users
  ADD COLUMN vault_salt BINARY(16) NULL AFTER password;

-- =============================================================
--  2. PREKEY_BUNDLES — bundle de clés publiques par utilisateur
-- =============================================================
CREATE TABLE IF NOT EXISTS prekey_bundles (
  alanyaID         INT          NOT NULL,
  registration_id  INT UNSIGNED NOT NULL,
  identity_key     VARBINARY(255) NOT NULL,
  signed_prekey    VARBINARY(255) NOT NULL,
  signed_prekey_id INT UNSIGNED NOT NULL,
  signature        VARBINARY(255) NOT NULL,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID),
  CONSTRAINT fk_prekey_bundle_user FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  3. ONE_TIME_PREKEYS — stock de prekeys à usage unique (X3DH)
-- =============================================================
CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID   INT          NOT NULL,
  key_id     INT UNSIGNED NOT NULL,
  public_key VARBINARY(255) NOT NULL,
  used       TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_key (alanyaID, key_id),
  CONSTRAINT fk_otp_user FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON DELETE CASCADE,
  -- Sert le SELECT ... FOR UPDATE de consommation atomique (B2) : trouver
  -- vite la prochaine prekey non utilisée d'un user.
  INDEX idx_otp_user_unused (alanyaID, used)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  4. MESSAGE — colonnes ciphertext (transport) + archive (coffre)
-- =============================================================
-- `content` reste utilisable pour les messages non chiffrés (groupes, ou
-- historique antérieur à l'E2EE). Pour un message E2EE 1-à-1, `content` est
-- NULL et `ciphertext` porte le payload chiffré par le ratchet.
ALTER TABLE message
  ADD COLUMN ciphertext         MEDIUMBLOB NULL AFTER content,
  ADD COLUMN archive_blob       MEDIUMBLOB NULL AFTER ciphertext,
  ADD COLUMN signal_message_type TINYINT   NULL COMMENT '1=prekey (X3DH initial) 2=normal (ratchet)' AFTER archive_blob;
