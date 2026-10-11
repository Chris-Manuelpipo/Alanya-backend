-- Stickers (type de message 10) : catalogue officiel, packs installés, favoris,
-- liste de blocage, signalements, interrupteurs de lancement.
--
-- Réexécutable : `CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`. Pas d'`ENUM`
-- (TINYINT), utf8mb4. AUCUN `ALTER message` : un sticker est un message de
-- `type = 10` dont le `content` est un JSON versionné.
--
-- Valeurs numériques (contrat CONTRAT-STICKERS.md §2) — ne jamais renuméroter :
--   sticker_asset.status     0 actif, 1 retiré
--   sticker_pack.visibility  0 officiel, 1 privé, 2 lien
--   sticker_pack.status      0 brouillon, 1 publié, 2 archivé
--   sticker_asset.owner_id   0 officiel (sentinelle : MySQL n'unicise pas les
--                            NULL), sinon alanyaID ; sticker_pack.owner_id
--                            reste NULL pour l'officiel.
--
-- Pas de clé étrangère vers `users` : `users.alanyaID` est un INT signé et
-- `owner_id = 0` n'y existe pas. La suppression de compte nettoie ces tables
-- par le code (voir plan §4), comme pour les autres données de compte.
--
-- Écart assumé au plan §5 : `sticker.name_i18n` (JSON, nullable) est ajouté.
-- `pack.json` du contrat expose un `name` par sticker (« Bienvenue sur
-- Alanya ») ; sans colonne, il ne pourrait pas être servi ni traduit.

CREATE TABLE IF NOT EXISTS sticker_asset (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id    INT NOT NULL DEFAULT 0
                COMMENT '0 = officiel (sentinelle, pas de FK) ; sinon alanyaID',
  sha256      CHAR(64) NOT NULL COMMENT 'empreinte du WebP ré-encodé par le serveur',
  storage_key VARCHAR(255) NOT NULL,
  thumb_key   VARCHAR(255) NULL,
  mime        VARCHAR(20) NOT NULL DEFAULT 'image/webp',
  width       SMALLINT UNSIGNED NULL,
  height      SMALLINT UNSIGNED NULL,
  bytes       INT UNSIGNED NULL,
  animated    TINYINT NOT NULL DEFAULT 0,
  status      TINYINT NOT NULL DEFAULT 0 COMMENT '0 actif, 1 retiré (suppression ou retrait admin)',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_asset_owner_sha (owner_id, sha256),
  KEY idx_asset_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sticker_pack (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code             VARCHAR(40) NOT NULL COMMENT "officiel : 'mboa' ; perso : 'u_<alanyaID>_<rand>'",
  owner_id         INT NULL COMMENT 'NULL = officiel',
  name_i18n        JSON NOT NULL COMMENT '{"fr":…,"en":…,"zh":…}',
  description_i18n JSON NULL,
  author           VARCHAR(80) NULL,
  cover_sticker_id BIGINT UNSIGNED NULL,
  is_premium       TINYINT NOT NULL DEFAULT 0,
  visibility       TINYINT NOT NULL DEFAULT 0 COMMENT '0 officiel, 1 privé, 2 lien',
  status           TINYINT NOT NULL DEFAULT 0 COMMENT '0 brouillon, 1 publié, 2 archivé',
  share_token      CHAR(24) NULL,
  sort_order       INT NOT NULL DEFAULT 0,
  version          INT UNSIGNED NOT NULL DEFAULT 1,
  published_at     DATETIME(3) NULL,
  created_by       INT NOT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pack_code (code),
  UNIQUE KEY uq_pack_share_token (share_token),
  KEY idx_pack_vis_stat_sort (visibility, status, sort_order),
  KEY idx_pack_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sticker (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pack_id   BIGINT UNSIGNED NOT NULL,
  position  SMALLINT NOT NULL,
  asset_id  BIGINT UNSIGNED NOT NULL,
  emoji     VARCHAR(16) NOT NULL,
  name_i18n JSON NULL COMMENT '{"fr":…,"en":…,"zh":…} ; repli en → fr',
  PRIMARY KEY (id),
  UNIQUE KEY uq_sticker_pos (pack_id, position),
  KEY idx_sticker_asset (asset_id),
  CONSTRAINT fk_sticker_pack  FOREIGN KEY (pack_id)  REFERENCES sticker_pack (id) ON DELETE CASCADE,
  CONSTRAINT fk_sticker_asset FOREIGN KEY (asset_id) REFERENCES sticker_asset (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sticker_pack (
  alanyaID INT NOT NULL,
  pack_id  BIGINT UNSIGNED NOT NULL,
  position SMALLINT NOT NULL DEFAULT 0,
  added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (alanyaID, pack_id),
  KEY idx_usp_pack (pack_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sticker_favorite (
  alanyaID   INT NOT NULL,
  sticker_id BIGINT UNSIGNED NOT NULL,
  added_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (alanyaID, sticker_id),
  KEY idx_usf_sticker (sticker_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sticker_blocklist (
  sha256     CHAR(64) NOT NULL,
  reason     VARCHAR(80) NULL,
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sticker_report (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_id    BIGINT UNSIGNED NOT NULL,
  reporter_id INT NOT NULL,
  reason      TINYINT NOT NULL DEFAULT 0,
  status      TINYINT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_report_asset (asset_id),
  KEY idx_report_reporter (reporter_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Une seule ligne (id = 1). FERMÉ par défaut : rien ne change pour personne
-- tant que le back-office n'ouvre pas `enabled`. Même patron de cohorte que
-- `e2ee_settings` (094) : liste explicite et/ou pourcentage par haché stable.
CREATE TABLE IF NOT EXISTS sticker_settings (
  id               TINYINT NOT NULL DEFAULT 1,
  enabled          TINYINT NOT NULL DEFAULT 0 COMMENT 'V1a : catalogue officiel',
  creation_enabled TINYINT NOT NULL DEFAULT 0 COMMENT 'V1b : création',
  animated_enabled TINYINT NOT NULL DEFAULT 0 COMMENT 'V1c : animé',
  cohort_ids       JSON NULL COMMENT 'alanyaID toujours dans la cohorte',
  cohort_percent   TINYINT NOT NULL DEFAULT 0,
  min_app_version  VARCHAR(20) NULL,
  updated_by       INT NULL,
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_sticker_settings_singleton CHECK (id = 1),
  CONSTRAINT ck_sticker_settings_percent CHECK (cohort_percent BETWEEN 0 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sticker_settings (id, enabled, creation_enabled, animated_enabled, cohort_percent)
VALUES (1, 0, 0, 0, 0);

-- `is_paid = 0` : régime TRIAL (3 mois d'essai, puis envoi réservé aux
-- abonnés). Dans ce régime l'envoi est déjà verrouillé par `outgoing` ; un pack
-- Royal derrière `is_paid = 1` se fermerait pour l'abonné tant que le plan ne
-- liste pas `stickers_premium`. Le code est déclaré pour que la réactivation du
-- régime Plus soit un réglage au back-office (`is_paid` à 1), pas une migration.
-- Cf. services/billing/rules.js (decideEntitlements).
INSERT IGNORE INTO feature (code, name_i18n, description_i18n, is_paid, is_available, sort_order) VALUES
  ('stickers_premium',
   JSON_OBJECT('fr', 'Stickers réservés', 'en', 'Premium stickers', 'zh', '高级贴纸'),
   JSON_OBJECT('fr', 'Installer et envoyer les packs réservés',
               'en', 'Install and send premium packs',
               'zh', '安装并发送高级贴纸包'),
   0, 1, 80);
