-- 061 — Suppression de message.mediaThumb, une fois la bascule vers
-- message_thumb (migration 060) validée en production.
--
-- ⚠️ NE PAS APPLIQUER AUTOMATIQUEMENT. Ce fichier est volontairement laissé
-- en attente après le déploiement du code qui lit/écrit message_thumb (voir
-- src/utils/messageInsert.js et les sites listés dans le plan d'implémen-
-- tation du 07/08/2026), pour garder un filet de rollback pendant une courte
-- période d'observation — même logique que la bascule i18n (053 → 054).
--
-- Avant d'exécuter : confirmer qu'aucune écriture n'est plus adressée à
-- message.mediaThumb (grep du code déployé) et que message_thumb contient
-- bien tous les mediaThumb non-NULL d'origine.

ALTER TABLE message DROP COLUMN mediaThumb;
