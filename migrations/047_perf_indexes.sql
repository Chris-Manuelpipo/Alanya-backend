-- 047 — Index de performance (audit scalabilité 2026-08-06, palier P0)
-- Voir docs/AUDIT_SCALABILITE_2026-08-06.md §2.3

-- Accusés de lecture/livraison : l'UPDATE `WHERE conversationID = ? AND status < 3`
-- (readReceiptUtils.js / deliveryReceiptUtils.js) scanne et verrouille tout
-- l'historique de la conversation à chaque ouverture d'écran.
ALTER TABLE message ADD INDEX idx_message_conv_status (conversationID, status, senderID);

-- Sync delta getMessagesSince : curseurs `(conversationID = ? AND msgID > ?)`
-- sans index adapté (idx_message_conv_date porte sendAt, pas msgID).
ALTER TABLE message ADD INDEX idx_message_conv_msgid (conversationID, msgID);

-- Polling de la file de jobs (jobQueue.js, jusqu'à 20×/s) : la requête ne filtre
-- pas sur `kind`, colonne de tête de idx_job_pret → full scan + verrous chaque tick.
ALTER TABLE job_queue ADD INDEX idx_job_ready (failed_at, locked_at, run_after, id);

-- Purge de jeton FCM mort : `UPDATE users SET fcm_token='INDEFINI' WHERE fcm_token = ?`
-- (notificationService.js) faisait un full scan de users par jeton invalide.
ALTER TABLE users ADD INDEX idx_users_fcm_token (fcm_token(191));

-- idx_users_phone est un doublon exact de la contrainte UNIQUE uq_phone
-- (confirmé sur la base de production) : coût d'écriture payé pour rien.
ALTER TABLE users DROP INDEX idx_users_phone;
