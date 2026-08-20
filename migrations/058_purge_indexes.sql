-- 058 — Index pour les purges de rétention (audit scalabilité, palier P1
-- tranche A). Voir docs/AUDIT_SCALABILITE_2026-08-06.md §2.5. Sans ces index,
-- chaque purge scannerait sa table entière. Vérifiés absents en production
-- le 07/08/2026 (SHOW INDEX).
--
-- user_export_jobs.expiresAt n'a jamais eu d'index alors que
-- cleanupExpiredExports() (accountLifecycleController.js) filtre dessus
-- toutes les heures — ajouté ici aussi.

ALTER TABLE appareils          ADD INDEX idx_appareils_revoked (revoked_at);
ALTER TABLE user_push_devices  ADD INDEX idx_push_heartbeat (lastHeartbeatAt);
ALTER TABLE users              ADD INDEX idx_users_reset_otp_exp (reset_otp_expires_at);
ALTER TABLE users              ADD INDEX idx_users_email_otp_exp (email_change_otp_expires_at);
ALTER TABLE broadcast_delivery ADD INDEX idx_delivery_purge (delivered_at);
ALTER TABLE user_export_jobs   ADD INDEX idx_export_jobs_expires (expiresAt);
