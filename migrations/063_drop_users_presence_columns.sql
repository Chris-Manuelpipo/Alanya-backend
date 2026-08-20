-- 063 — Suppression de users.is_online / users.last_seen, une fois la
-- bascule vers user_presence (migration 062) validée en production.
--
-- ⚠️ NE PAS APPLIQUER AUTOMATIQUEMENT. Contrairement à message_crypto, ces
-- colonnes sont activement lues/écrites par ~20 sites de code avant la
-- migration — filet de rollback volontaire pendant une période
-- d'observation, même logique que la bascule mediaThumb (060 → 061).
--
-- Avant d'exécuter : confirmer par grep qu'aucun code déployé ne référence
-- plus `users.is_online`/`users.last_seen` (le code doit lire/écrire
-- exclusivement `user_presence` à ce stade), et que le comportement de
-- présence en production est identique à avant la bascule.

ALTER TABLE users
  DROP COLUMN is_online,
  DROP COLUMN last_seen;
