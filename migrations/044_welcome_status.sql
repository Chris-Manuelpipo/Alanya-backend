-- Migration 044 : statut de bienvenue ALANYA
--
-- Un statut 24 h publié par le compte officiel au moment de la livraison du
-- message de bienvenue, visible du seul destinataire.
--
-- Deux choix structurants, décidés côté produit :
--
--  1. Réglage GLOBAL et non versionné, contrairement à `welcome_config` :
--     l'interrupteur doit agir immédiatement, sans passer par « Publier ».
--     D'où une table singleton distincte plutôt qu'une colonne sur
--     `welcome_config`.
--
--  2. Un statut par destinataire. `statut` n'a pas de ciblage : la visibilité
--     passe par `welcome_status_delivery`, qui sert à la fois de clé de
--     visibilité (le seul `alanyaID` autorisé à voir la ligne) et de garde
--     anti-doublon (UNIQUE), exactement comme `welcome_delivery` pour le
--     message.

CREATE TABLE IF NOT EXISTS welcome_status_config (
  id               TINYINT      NOT NULL DEFAULT 1 COMMENT 'Singleton : toujours 1',
  enabled          TINYINT      NOT NULL DEFAULT 0,
  type             TINYINT      NOT NULL DEFAULT 0 COMMENT '0=texte 1=image 2=vidéo',
  -- TINYTEXT comme `statut.text` : 255 octets, à refléter dans la validation.
  text_fr          TINYTEXT     NULL,
  text_en          TINYTEXT     NULL,
  media_url        VARCHAR(512) NULL,
  background_color VARCHAR(20)  NULL COMMENT '#RRGGBB ; NULL = indigo de marque',
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by       INT          NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS welcome_status_delivery (
  id           BIGINT   NOT NULL AUTO_INCREMENT,
  alanyaID     INT      NOT NULL,
  statut_id    INT      NOT NULL,
  delivered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_welcome_status_user (alanyaID),
  KEY idx_welcome_status_statut (statut_id),
  CONSTRAINT fk_wsd_user FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_wsd_statut FOREIGN KEY (statut_id) REFERENCES statut(ID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ligne unique, désactivée : rien ne change tant qu'un super-admin n'active pas.
INSERT IGNORE INTO welcome_status_config (id, enabled, type, text_fr, text_en)
VALUES (
  1, 0, 0,
  'Bienvenue sur Alanya ! Faites le tour de l''app et dites-nous ce que vous en pensez.',
  'Welcome to Alanya! Take a look around and tell us what you think.'
);
