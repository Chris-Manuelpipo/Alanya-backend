-- Migration 012: stockage des blobs médias chiffrés (envelope encryption)
--
-- Voir MEDIAS_E2EE.md. Le fichier est chiffré côté client (AES-256-GCM, clé
-- média jetable) AVANT l'upload : le serveur ne reçoit et ne stocke qu'un
-- blob opaque. La clé média, l'URL, le hash, le mime et le nom réels
-- voyagent uniquement DANS le message E2EE (ratchet ou GroupCipher),
-- jamais ici.
--
-- Cette table ne contient donc que des métadonnées techniques sur un blob
-- opaque : aucune clé, aucun contenu en clair, aucun mime/nom réel.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` : si la colonne existe
-- déjà, ignorer l'erreur 1060 (Duplicate column name) à l'exécution.

USE alanyBD2027;

CREATE TABLE IF NOT EXISTS media_blobs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uploader_id  INT          NOT NULL,
  storage_key  VARCHAR(255) NOT NULL,
  sha256       BINARY(32)   NOT NULL,
  byte_size    BIGINT UNSIGNED NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_media_blob_storage_key (storage_key),
  CONSTRAINT fk_media_blob_uploader FOREIGN KEY (uploader_id) REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
