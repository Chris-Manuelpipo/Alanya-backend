-- =============================================================
--  071 — Statut de bienvenue : plusieurs éléments
-- =============================================================
-- Le message d'accueil est une suite de blocs (`welcome_block`) depuis la 042,
-- mais le statut est resté ce que la 044 en avait fait : une table à ligne
-- unique, donc un seul statut par inscrit. L'asymétrie n'avait pas de raison
-- d'être — un accueil se raconte souvent en deux ou trois vignettes.
--
-- `welcome_status_config` survit et garde son rôle utile : l'interrupteur
-- global (`enabled`). Ses colonnes de contenu deviennent le reflet du premier
-- élément, conservé le temps qu'un retour en arrière reste possible.
--
-- Rejouable : `CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`, et les `ALTER`
-- sont gardés par des tests sur `information_schema`.

-- -------------------------------------------------------------
--  1. Les éléments
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS welcome_status_block (
  id               INT          NOT NULL AUTO_INCREMENT,
  sort_order       INT          NOT NULL DEFAULT 0,
  type             TINYINT      NOT NULL DEFAULT 0 COMMENT '0=texte 1=image 2=vidéo',
  media_url        VARCHAR(512) NULL,
  background_color VARCHAR(20)  NULL COMMENT '#RRGGBB ; NULL = indigo de marque',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_wsb_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Le texte vit dans sa table de traductions, comme partout depuis la 053 :
-- pas de colonne `_xx` à poser le jour où une langue s'ajoute.
-- TINYTEXT comme `statut.text` : 255 octets, à refléter dans la validation.
CREATE TABLE IF NOT EXISTS welcome_status_block_i18n (
  block_id INT        NOT NULL,
  locale   VARCHAR(8) NOT NULL,
  text     TINYTEXT   NOT NULL,
  PRIMARY KEY (block_id, locale),
  CONSTRAINT fk_wsb_i18n FOREIGN KEY (block_id)
    REFERENCES welcome_status_block(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  2. Reprise du statut unique en premier élément
-- -------------------------------------------------------------
-- Uniquement s'il porte quelque chose : la 044 insère une ligne par défaut,
-- reprendre une configuration vide créerait un élément fantôme dans l'éditeur.
INSERT INTO welcome_status_block (id, sort_order, type, media_url, background_color)
SELECT 1, 0, c.type, c.media_url, c.background_color
FROM welcome_status_config c
WHERE c.id = 1
  AND ((c.text_fr IS NOT NULL AND TRIM(c.text_fr) <> '') OR c.media_url IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM welcome_status_block);

-- Traductions : la table normalisée d'abord, les colonnes héritées ensuite.
INSERT IGNORE INTO welcome_status_block_i18n (block_id, locale, text)
SELECT 1, i.locale, i.text
FROM welcome_status_config_i18n i
WHERE i.config_id = 1
  AND EXISTS (SELECT 1 FROM welcome_status_block WHERE id = 1)
  AND TRIM(i.text) <> '';

INSERT IGNORE INTO welcome_status_block_i18n (block_id, locale, text)
SELECT 1, 'fr', c.text_fr
FROM welcome_status_config c
WHERE c.id = 1 AND c.text_fr IS NOT NULL AND TRIM(c.text_fr) <> ''
  AND EXISTS (SELECT 1 FROM welcome_status_block WHERE id = 1);

INSERT IGNORE INTO welcome_status_block_i18n (block_id, locale, text)
SELECT 1, 'en', c.text_en
FROM welcome_status_config c
WHERE c.id = 1 AND c.text_en IS NOT NULL AND TRIM(c.text_en) <> ''
  AND EXISTS (SELECT 1 FROM welcome_status_block WHERE id = 1);

-- -------------------------------------------------------------
--  3. Livraison : une ligne par (utilisateur, élément)
-- -------------------------------------------------------------
-- `UNIQUE (alanyaID)` disait « un seul statut de bienvenue par compte » ; la
-- règle devient « un seul exemplaire de chaque élément par compte ».
--
-- `ON DELETE SET NULL` et non CASCADE : supprimer un élément dans l'éditeur ne
-- doit pas effacer la trace des livraisons déjà faites, sans quoi le statut
-- correspondant disparaîtrait de l'écran de son destinataire — il est servi
-- par une jointure sur cette table (statutController) — et échapperait à la
-- purge, qui passe par la même jointure.
SET @has_block_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'welcome_status_delivery'
    AND COLUMN_NAME = 'block_id'
);
SET @sql := IF(@has_block_id = 0,
  'ALTER TABLE welcome_status_delivery ADD COLUMN block_id INT NULL AFTER alanyaID',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les livraisons antérieures portaient toutes le statut unique, devenu
-- l'élément 1.
UPDATE welcome_status_delivery SET block_id = 1
WHERE block_id IS NULL
  AND EXISTS (SELECT 1 FROM welcome_status_block WHERE id = 1);

-- Poser le nouvel index AVANT de lâcher l'ancien, et non l'inverse :
-- `uq_welcome_status_user (alanyaID)` est le seul index qui porte la clé
-- étrangère `fk_wsd_user`, et MySQL refuse de le supprimer tant qu'aucun autre
-- ne couvre la colonne (erreur 1553). `uq_welcome_status_user_block` a
-- `alanyaID` en tête : il prend le relais de la contrainte, ce qui libère
-- l'ancien. Les deux cohabitent le temps d'un ALTER, l'ancien étant le plus
-- strict des deux, aucune ligne ne peut se glisser entre les deux ordres.
SET @has_new_uq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'welcome_status_delivery'
    AND INDEX_NAME = 'uq_welcome_status_user_block'
);
SET @sql := IF(@has_new_uq = 0,
  'ALTER TABLE welcome_status_delivery ADD UNIQUE KEY uq_welcome_status_user_block (alanyaID, block_id)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_old_uq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'welcome_status_delivery'
    AND INDEX_NAME = 'uq_welcome_status_user'
);
SET @sql := IF(@has_old_uq > 0,
  'ALTER TABLE welcome_status_delivery DROP INDEX uq_welcome_status_user',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'welcome_status_delivery'
    AND CONSTRAINT_NAME = 'fk_wsd_block'
);
SET @sql := IF(@has_fk = 0,
  'ALTER TABLE welcome_status_delivery ADD CONSTRAINT fk_wsd_block FOREIGN KEY (block_id) REFERENCES welcome_status_block(id) ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------
--  4. Vérifications
-- -------------------------------------------------------------
-- SELECT
--   (SELECT COUNT(*) FROM welcome_status_block)                       AS elements,
--   (SELECT COUNT(*) FROM welcome_status_block_i18n)                  AS traductions,
--   (SELECT COUNT(*) FROM welcome_status_delivery WHERE block_id IS NULL) AS livraisons_orphelines;
--
-- Reprise correcte si `elements` vaut 1 quand le statut portait un contenu,
-- 0 sinon, et si `livraisons_orphelines` vaut 0.
