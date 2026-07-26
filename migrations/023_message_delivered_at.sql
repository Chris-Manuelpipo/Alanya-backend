-- =============================================================
--  Migration 023 : message.deliveredAt (rattrapage de la 017)
-- =============================================================
-- La 017 documentait `deliveredAt` mais laissait son ALTER TABLE en
-- commentaire. La colonne a été ajoutée à la main en production ; toute base
-- reconstruite depuis le dépôt (environnement de test, nouvelle instance)
-- repartait donc sans elle, alors que trois requêtes l'écrivent :
--   - src/socket/handlers/chat/receipts.js  (message:delivered, message:read)
--   - src/utils/readReceiptUtils.js         (POST /conversations/:id/read)
--   - src/utils/deliveryReceiptUtils.js     (POST /messages/delivered)
-- Sans la colonne, ces requêtes échouent en ER_BAD_FIELD_ERROR et les accusés
-- de réception ne montent jamais.
--
-- Réexécution : ignorer l'erreur "Duplicate column name 'deliveredAt'" si la
-- migration a déjà été appliquée (même convention que la 022).

ALTER TABLE message
  ADD COLUMN deliveredAt DATETIME NULL COMMENT 'Instant de remise sur le terminal destinataire (2 coches grises)' AFTER readAt;
