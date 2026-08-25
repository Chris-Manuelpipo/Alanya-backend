-- Migration 068 : réglages des purges de rétention, pilotables depuis l'admin
--
-- Les cinq purges nocturnes (médias, diffusions, statuts d'accueil, traces de
-- trajets, rétention générale) n'avaient aucun interrupteur : les couper
-- imposait de modifier le code et de redéployer. Or ces purges suppriment
-- définitivement des fichiers et des lignes — il faut pouvoir les arrêter
-- immédiatement, et voir ce qu'elles s'apprêtent à faire avant de les relancer.
--
-- Pourquoi une table plutôt que `data/app-settings.json` (où vit déjà le flag
-- `maintenance`) : ce fichier n'est pas versionné et n'existe que sur le disque
-- du serveur. Machine reconstruite ou fichier perdu = le réglage retombe
-- silencieusement sur sa valeur par défaut. Pour un interrupteur qui commande
-- une suppression irréversible, ce mode de défaillance est le mauvais sens.
-- La base est aussi le seul support correct quand plusieurs instances tournent.
--
-- `overrides` porte les durées de rétention surchargées, en JSON, parce que les
-- cinq purges n'exposent pas les mêmes réglages : les médias ont une seule
-- durée, les trajets trois, les diffusions et la rétention générale aucune
-- (durées figées dans leur SQL). Une colonne par réglage serait ingérable ;
-- le registre applicatif (src/services/purgeRegistry.js) décrit quelles clés
-- sont valides pour chaque purge et les borne.
--
-- NULL dans `overrides` = utiliser la valeur par défaut du code / de
-- l'environnement. Absence de ligne = purge active avec ses défauts.

CREATE TABLE IF NOT EXISTS purge_settings (
  name        VARCHAR(64)  NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  overrides   JSON         NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by  VARCHAR(128) NULL,
  PRIMARY KEY (name)
);

-- Les cinq purges, actives par défaut : l'état de départ reproduit exactement
-- le comportement actuel, la migration ne change donc rien à elle seule.
INSERT IGNORE INTO purge_settings (name, enabled) VALUES
  ('media',          1),
  ('broadcast',      1),
  ('welcome_status', 1),
  ('trip',           1),
  ('data_retention', 1);

-- Journal des exécutions. Sans lui, rien ne distingue « la purge tourne et
-- n'a rien à faire » de « la purge ne tourne pas » : c'est exactement ce qui
-- a permis au bug d'alias SQL de la purge des médias de passer inaperçu
-- pendant des semaines (la requête échouait à chaque nuit, en silence).
-- `trigger_source` distingue le balayage automatique d'un déclenchement
-- manuel depuis l'admin. `result` porte le détail par cible (JSON), la forme
-- variant d'une purge à l'autre.
CREATE TABLE IF NOT EXISTS purge_runs (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  name           VARCHAR(64)  NOT NULL,
  ran_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  trigger_source ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  by_admin       VARCHAR(128) NULL,
  ok             TINYINT(1)   NOT NULL DEFAULT 1,
  result         JSON         NULL,
  error          TEXT         NULL,
  duration_ms    INT          NULL,
  PRIMARY KEY (id),
  KEY idx_purge_runs_name_date (name, ran_at)
);
