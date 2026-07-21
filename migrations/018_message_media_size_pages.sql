-- Taille (octets) et nombre de pages PDF, renseignés par le client à l'envoi.
ALTER TABLE message
  ADD COLUMN mediaSize BIGINT NULL COMMENT 'Taille du fichier en octets',
  ADD COLUMN mediaPageCount INT NULL COMMENT 'Nombre de pages (PDF uniquement)';
