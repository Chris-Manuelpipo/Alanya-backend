-- Migration 011: transport du header Double Ratchet 1-à-1
--
-- Le nonce AES-GCM (12 octets) et le header DR (JSON opaque : DH public,
-- compteurs n/pn, éventuel bootstrap X3DH) n'étaient ni stockés ni relayés
-- par le backend — uniquement `ciphertext` l'était. Sans eux, le
-- destinataire d'un message 1-à-1 ne peut JAMAIS le déchiffrer (seul
-- l'émetteur voyait son propre message, restauré depuis sa copie locale).
--
-- Le serveur reste zero-knowledge : `dr_nonce`/`dr_header` sont des données
-- publiques du protocole (clé DH éphémère, compteurs), jamais la clé privée
-- ni le contenu en clair.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` : si la colonne existe
-- déjà, ignorer l'erreur 1060 (Duplicate column name) à l'exécution.

USE alanyBD2027;

ALTER TABLE message
  ADD COLUMN dr_nonce  VARBINARY(16) NULL AFTER ciphertext,
  ADD COLUMN dr_header TEXT          NULL AFTER dr_nonce;
