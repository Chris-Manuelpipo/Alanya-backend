-- Média à vue unique (« view once »).
-- Vue unique réservée aux discussions 1-1 : plus besoin de suivre les vues
-- par destinataire. On remplace la table `message_views` par une simple
-- colonne sur `message` (un seul destinataire ⇒ vu / pas vu suffit).
ALTER TABLE message
  ADD COLUMN isViewOnce TINYINT NOT NULL DEFAULT 0 COMMENT '1 = média à vue unique';
  ADD COLUMN viewedAt DATETIME NULL COMMENT 'Média vue unique consulté (1-1)';


