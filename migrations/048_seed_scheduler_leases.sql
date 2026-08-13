-- 048 — Semis des baux de schedulers manquants (audit scalabilité 2026-08-06, palier P0)
--
-- tryAcquire (schedulerLease.js) est un UPDATE : il ne crée jamais la ligne.
-- Le bail 'welcome_status_purge' utilisé par server.js n'avait jamais été semé
-- (039 n'en seme que 4) → la purge des statuts de bienvenue n'a jamais tourné
-- (constaté en production : 100 % des statuts expirés toujours en base).
-- 'account_lifecycle' accompagne la mise sous bail de startAccountLifecycleSchedulers.
--
-- Note : schedulerLease.tryAcquire est désormais auto-créateur (INSERT IGNORE
-- avant l'UPDATE), ce semis reste utile pour l'état initial documenté.
INSERT IGNORE INTO scheduler_leases (name) VALUES
  ('welcome_status_purge'),
  ('account_lifecycle');
