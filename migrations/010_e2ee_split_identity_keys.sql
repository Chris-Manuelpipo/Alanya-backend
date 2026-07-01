-- Migration 010: scinde prekey_bundles.identity_key en deux clés distinctes
--
-- Le frontend (F1) utilise deux paires de clés d'identité séparées, à la
-- manière de XEdDSA explicite :
--   - identity_key_dh   : clé X25519, utilisée pour le DH du X3DH
--   - identity_key_sign : clé Ed25519, utilisée pour vérifier la signature
--                         du signed prekey
-- L'ancienne colonne `identity_key` unique ne permettait pas cette
-- distinction. registration_id devient optionnel : le frontend actuel ne
-- l'envoie pas.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` :
-- si la colonne existe déjà / n'existe plus, ignorer l'erreur 1060/1091.

USE alanyBD2027;

ALTER TABLE prekey_bundles
  ADD COLUMN identity_key_dh   VARBINARY(255) NULL AFTER alanyaID,
  ADD COLUMN identity_key_sign VARBINARY(255) NULL AFTER identity_key_dh,
  MODIFY COLUMN registration_id INT UNSIGNED NULL;

ALTER TABLE prekey_bundles
  DROP COLUMN identity_key;
