-- Identité QR (users.qr_public_id) + registre des appareils connectés
-- (appareils), alimenté par toute connexion (login, register, QR) — voir
-- docs/architecture/contenu/qr-code-technique.tex.
--
-- ⚠ ORDRE DE DÉPLOIEMENT — APPLIQUER CETTE MIGRATION AVANT DE DÉPLOYER LE CODE.
-- Les trois gardes d'authentification (src/middleware/auth.js,
-- src/middleware/authCustom.js, src/socket/handlers/auth.js) joignent `appareils`
-- à chaque requête authentifiée. Code déployé sans la table = ER_NO_SUCH_TABLE
-- sur TOUTE l'API, pas seulement sur le QR : messages, appels et /auth/me
-- tombent aussi. Les migrations n'ont pas de runner ici, elles s'appliquent à
-- la main : c'est donc à vérifier explicitement au déploiement.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` (cf. migration 008) :
-- si relancée après un premier passage réussi, ignorer l'erreur 1060
-- (Duplicate column name) / 1061 (Duplicate key name) à l'exécution.

ALTER TABLE users
  ADD COLUMN qr_public_id VARCHAR(64) NULL,
  ADD UNIQUE KEY uq_users_qr_public_id (qr_public_id);

CREATE TABLE IF NOT EXISTS appareils (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  alanyaID INT NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  push_device_id VARCHAR(128) NULL,
  device_name VARCHAR(120) NULL,
  -- VARCHAR et non ENUM : le client envoie aussi macOS / Windows / Linux, et
  -- ajouter une plateforme ne doit pas demander un ALTER TABLE.
  platform VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ip_address VARCHAR(64) NULL,
  login_method ENUM('password','register','qr') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  UNIQUE KEY uq_appareils_user_device (alanyaID, device_id),
  KEY idx_appareils_user (alanyaID, revoked_at),
  CONSTRAINT fk_appareils_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
