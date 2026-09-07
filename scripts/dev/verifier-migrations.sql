-- Vérifie que les migrations 069 à 078 ont bien atterri dans la base.
--
-- Rien dans ce projet ne trace les migrations appliquées : la seule façon de
-- répondre à « la 073 est-elle passée ? » est de chercher ce qu'elle crée.
-- Ce fichier le fait pour chacune. Il ne modifie rien.
--
--   mysql -u <utilisateur> -p <base> < scripts/dev/verifier-migrations.sql
--
-- Toute ligne à « ABSENTE » signale une migration à appliquer.
SELECT m AS migration,
       IF(n > 0, 'ok', '*** ABSENTE ***') AS etat
FROM (
  SELECT '069 trip_stale (lease)' AS m,
         (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trip'
             AND COLUMN_NAME LIKE '%lease%') AS n
  UNION ALL SELECT '070 idx_message_conv_msgid_sent',
         (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND INDEX_NAME = 'idx_message_conv_msgid_sent')
  UNION ALL SELECT '071 welcome_status_block',
         (SELECT COUNT(*) FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'welcome_status_block')
  UNION ALL SELECT '072 admin_audit',
         (SELECT COUNT(*) FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_audit')
  UNION ALL SELECT '073 report + report_action',
         (SELECT COUNT(*) FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME IN ('report','report_action')) DIV 2
  UNION ALL SELECT '075 callHistory.start_time nullable',
         (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'callHistory'
             AND COLUMN_NAME = 'start_time' AND IS_NULLABLE = 'YES')
  UNION ALL SELECT '076 idx_meeting_room',
         (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'idx_meeting_room')
  UNION ALL SELECT '078 users.backup_*',
         (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
             AND COLUMN_NAME LIKE 'backup\_%') DIV 5
  UNION ALL SELECT '078 backup_key_secrets',
         (SELECT COUNT(*) FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_key_secrets')
) v;

-- Le secret de sauvegarde a-t-il été remplacé ? Tant qu'il vaut le marqueur,
-- le serveur REFUSE de servir une clé : aucune sauvegarde ne peut être écrite.
SELECT kid,
       IF(secret = 'REMPLACER_AU_DEPLOIEMENT',
          '*** ENCORE LE MARQUEUR ***', 'remplacé') AS secret
FROM backup_key_secrets;
