-- 065 — Suppression des 5 colonnes de chiffrement E2E de `message`, une
-- fois leurs données sauvegardées dans message_crypto (migration 064).
--
-- Appliquée dans la même passe que 064 (contrairement à mediaThumb/
-- users.is_online-last_seen) : aucun code de `main` ne référence ces
-- colonnes (grep exhaustif à 0 résultat), donc aucune fenêtre d'observation
-- n'est nécessaire — il n'y a pas de code actif à laisser le temps de
-- s'adapter.

ALTER TABLE message
  DROP COLUMN ciphertext,
  DROP COLUMN dr_nonce,
  DROP COLUMN dr_header,
  DROP COLUMN archive_blob,
  DROP COLUMN signal_message_type;
