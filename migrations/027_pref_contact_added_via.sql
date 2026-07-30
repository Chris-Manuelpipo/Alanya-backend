-- Origine d'un contact préféré : 'search' (recherche manuelle) ou 'qr' (scan
-- ou lien d'un code QR). Alimente la pastille, le filtre « Par QR » et la
-- mention datée de la fiche contact.
--
-- VARCHAR et non ENUM : ajouter une origine (partage de fiche, import…) ne
-- doit pas demander un ALTER TABLE.
--
-- ⚠ ORDRE DE DÉPLOIEMENT — APPLIQUER AVANT DE DÉPLOYER LE CODE : l'INSERT de
-- contactService nomme la colonne. MySQL 8 ne supporte pas ADD COLUMN IF NOT
-- EXISTS (cf. migration 008) : en cas de relance, ignorer l'erreur 1060.

ALTER TABLE preferredContact
  ADD COLUMN added_via VARCHAR(16) NOT NULL DEFAULT 'search';
