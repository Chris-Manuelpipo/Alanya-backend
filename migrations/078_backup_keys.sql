-- Migration 078 : clés de chiffrement des sauvegardes, et métadonnée de compte
--
-- L'application dépose sur le Drive de l'inscrit une sauvegarde chiffrée de sa
-- base locale. La clé n'est pas choisie par lui : elle est dérivée ici, d'un
-- secret serveur et de son `alanyaID`. Il n'a donc rien à retenir, et la
-- restauration est transparente.
--
-- ── Pourquoi une TABLE de secrets, et pas une variable d'environnement ──
--
-- Fuite, changement d'hébergeur, simple hygiène : un secret finit toujours par
-- devoir être remplacé. Avec une variable d'environnement unique, ce
-- remplacement rendrait **illisibles d'un coup toutes les sauvegardes déjà
-- déposées**, sans recours et sans avertissement — y compris celles d'inscrits
-- qui n'ouvriront l'application que dans six mois.
--
-- Chaque archive porte donc, dans son en-tête EN CLAIR, le numéro de version
-- (`kid`) de la clé qui l'a chiffrée. Le serveur sert la version courante pour
-- écrire, et n'importe quelle version passée pour relire.
--
-- **Aucune ligne de cette table n'est jamais supprimée.** « Retirer » une
-- version signifie uniquement cesser d'écrire avec elle (`retired_at` posé),
-- jamais cesser de la servir. Supprimer une ligne détruirait définitivement
-- l'accès aux archives correspondantes.
--
-- ── Pourquoi la métadonnée de sauvegarde sur le compte ──
--
-- Sur un téléphone neuf, l'application doit savoir qu'une sauvegarde existe
-- AVANT de demander un compte Google. Sans cette information, il faudrait
-- interroger Drive à l'aveugle au tout premier démarrage — donc réclamer un
-- compte tiers au pire moment, y compris à ceux qui n'ont jamais rien
-- sauvegardé.
--
-- Ces colonnes ne contiennent AUCUN contenu : date, taille, version de clé, et
-- l'adresse Google **masquée** (`a•••@gmail.com`). Masquée et non complète :
-- la première lettre et le domaine suffisent à guider l'inscrit vers le bon
-- compte, en conserver davantage serait accumuler de la donnée personnelle
-- pour rien.

CREATE TABLE IF NOT EXISTS backup_key_secrets (
  kid         INT UNSIGNED NOT NULL,
  -- Secret maître de la version, 32 octets en base64. Ce n'est PAS la clé
  -- servie : celle-ci en est dérivée avec l'`alanyaID`, si bien qu'une même
  -- version produit une clé différente pour chaque compte.
  secret      VARCHAR(64)  NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Renseigné = on n'écrit plus avec cette version, mais on la sert toujours.
  retired_at  DATETIME     NULL,
  PRIMARY KEY (kid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Version initiale. Le secret DOIT être remplacé au déploiement par une valeur
-- tirée au hasard :
--
--   UPDATE backup_key_secrets
--      SET secret = '<32 octets aléatoires en base64>'
--    WHERE kid = 1;
--
-- La valeur ci-dessous est un marqueur volontairement inutilisable : le
-- contrôleur refuse de servir une clé dont le secret vaut encore ce texte,
-- plutôt que de chiffrer des sauvegardes avec un secret public.
INSERT INTO backup_key_secrets (kid, secret)
SELECT 1, 'REMPLACER_AU_DEPLOIEMENT'
WHERE NOT EXISTS (SELECT 1 FROM backup_key_secrets);

-- ── Métadonnée de sauvegarde, portée par le compte ──────────────────────

-- Rejouable, comme la 071 : les colonnes sont posées une à une derrière un
-- test sur `information_schema`. Sans ce garde-fou, rejouer la migration
-- s'arrête sur « Duplicate column name » — ce qui arrive forcément ici,
-- puisque ce fichier a d'abord porté le numéro 069 et a été appliqué sous ce
-- nom-là. Rien ne trace les migrations passées dans ce projet : la seule
-- protection est que le fichier supporte d'être rejoué.
--
-- `backup_account_hint` : adresse Google masquée, jamais complète. Sert
-- uniquement à dire « connectez-vous avec a•••@gmail.com » au lieu d'un
-- « aucune sauvegarde trouvée » indiscernable d'une absence réelle.

SET @col := 'backup_last_at';
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = @col);
SET @sql := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN backup_last_at DATETIME NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := 'backup_bytes';
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = @col);
SET @sql := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN backup_bytes BIGINT UNSIGNED NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := 'backup_kid';
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = @col);
SET @sql := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN backup_kid INT UNSIGNED NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := 'backup_message_count';
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = @col);
SET @sql := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN backup_message_count INT UNSIGNED NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := 'backup_account_hint';
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = @col);
SET @sql := IF(@has = 0,
  'ALTER TABLE users ADD COLUMN backup_account_hint VARCHAR(64) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
