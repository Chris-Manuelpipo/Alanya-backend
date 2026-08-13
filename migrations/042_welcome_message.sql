-- Migration 042 : message de bienvenue ALANYA (config versionnée + livraisons)

CREATE TABLE IF NOT EXISTS welcome_config (
  id           BIGINT   NOT NULL AUTO_INCREMENT,
  version      INT      NOT NULL DEFAULT 1,
  is_active    TINYINT  NOT NULL DEFAULT 0,
  is_draft     TINYINT  NOT NULL DEFAULT 0,
  published_at DATETIME NULL,
  published_by INT      NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_welcome_active (is_active),
  KEY idx_welcome_draft (is_draft)
);
 
CREATE TABLE IF NOT EXISTS welcome_block (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  config_id  BIGINT      NOT NULL,
  sort_order INT         NOT NULL DEFAULT 0,
  block_type ENUM('text','image','video','cta') NOT NULL,
  content_fr TEXT        NULL,
  content_en TEXT        NULL,
  media_url  VARCHAR(512) NULL,
  cta_json   JSON        NULL,
  PRIMARY KEY (id),
  KEY idx_welcome_block_config (config_id, sort_order),
  CONSTRAINT fk_welcome_block_config FOREIGN KEY (config_id) REFERENCES welcome_config(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS welcome_delivery (
  id           BIGINT   NOT NULL AUTO_INCREMENT,
  alanyaID     INT      NOT NULL,
  config_id    BIGINT   NOT NULL,
  conversID    INT      NOT NULL,
  delivered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_welcome_user (alanyaID),
  KEY idx_welcome_delivery_config (config_id),
  CONSTRAINT fk_welcome_delivery_config FOREIGN KEY (config_id) REFERENCES welcome_config(id)
);

-- Brouillon initial + version 1 publiée (contenu par défaut FR/EN)
INSERT INTO welcome_config (version, is_active, is_draft, published_at)
VALUES (1, 1, 0, NOW());

SET @active_id = LAST_INSERT_ID();

INSERT INTO welcome_config (version, is_active, is_draft)
VALUES (1, 0, 1);

SET @draft_id = LAST_INSERT_ID();

INSERT INTO welcome_block (config_id, sort_order, block_type, content_fr, content_en) VALUES
(@active_id, 0, 'text',
 'Bienvenue sur Alanya ! 👋\n\nNous sommes ravis de vous compter parmi nous. Ce compte officiel vous informera des annonces importantes.',
 'Welcome to Alanya! 👋\n\nWe''re glad to have you here. This official account will share important updates with you.'),
(@active_id, 1, 'text',
 'Découvrez la messagerie, les statuts 24 h, les appels audio et vidéo, ainsi que les réunions — le tout dans une seule application.',
 'Discover messaging, 24 h statuses, audio and video calls, and meetings — all in one app.'),
(@active_id, 2, 'cta', NULL, NULL);

-- Piège : après une insertion multi-lignes, LAST_INSERT_ID() renvoie
-- l'identifiant de la PREMIÈRE ligne. L'utiliser ici écrivait les boutons sur
-- le premier bloc texte et laissait le bloc CTA vide. On désigne donc le bloc
-- explicitement.
SELECT id INTO @cta_block
FROM welcome_block
WHERE config_id = @active_id AND block_type = 'cta'
ORDER BY sort_order LIMIT 1;

UPDATE welcome_block SET cta_json = JSON_OBJECT(
  'buttons', JSON_ARRAY(
    JSON_OBJECT('labelFr', 'Compléter mon profil', 'labelEn', 'Complete my profile', 'action', 'route', 'target', 'profile'),
    JSON_OBJECT('labelFr', 'Aide et FAQ', 'labelEn', 'Help and FAQ', 'action', 'route', 'target', 'help')
  )
) WHERE id = @cta_block;

INSERT INTO welcome_block (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
SELECT @draft_id, sort_order, block_type, content_fr, content_en, media_url, cta_json
FROM welcome_block WHERE config_id = @active_id;
