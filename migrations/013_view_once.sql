-- Média à vue unique (« view once »).
-- Vue unique réservée aux discussions 1-1 : plus besoin de suivre les vues
-- par destinataire. On remplace la table `message_views` par une simple
-- colonne sur `message` (un seul destinataire ⇒ vu / pas vu suffit).
-- Une colonne par ALTER : un `;` égaré laissait « ADD COLUMN viewedAt … » comme
-- instruction autonome, donc une erreur 1064 et un fichier inexécutable tel
-- quel — toute base reconstruite depuis le dépôt repartait sans `viewedAt`,
-- dont dépend tout le média à vue unique.
ALTER TABLE message
  ADD COLUMN isViewOnce TINYINT NOT NULL DEFAULT 0 COMMENT '1 = média à vue unique';
ALTER TABLE message
  ADD COLUMN viewedAt DATETIME NULL COMMENT 'Média vue unique consulté (1-1)';


