-- Migration 073 : signalements et traçabilité des décisions de modération
--
-- ALANYA n'avait aucun mécanisme de signalement — ni dans l'application, ni
-- dans les routes, ni dans le schéma. La table `blocked` existe mais couvre
-- autre chose : le blocage individuel est de l'autodéfense, il n'informe
-- personne et ne déclenche aucune revue. Une personne qui reçoit du
-- harcèlement n'avait donc littéralement pas de bouton à presser.
--
-- Deux tables : ce qui est signalé, et ce que l'équipe en a fait. La seconde
-- n'est pas un luxe — sans elle, « ce compte a déjà été signalé trois fois »
-- et « ces trois signalements ont été jugés infondés » sont indiscernables.

-- -------------------------------------------------------------
--  1. Les signalements
-- -------------------------------------------------------------
-- Deux colonnes de cible typées plutôt qu'un couple (target_type, target_id)
-- polymorphe : le couple interdit toute clé étrangère, et la 067 a montré ce
-- que ça coûte — des lignes orphelines créées en silence par le job de purge
-- lui-même, découvertes des semaines plus tard. Ici chaque cible pointe vers
-- sa table.
--
-- « Exactement une cible renseignée » n'est PAS une contrainte CHECK : MySQL
-- refuse (erreur 3823) qu'une colonne porteuse d'une action référentielle
-- — ici `ON DELETE SET NULL` et `ON DELETE CASCADE` — apparaisse dans un
-- CHECK. Entre la contrainte et les clés étrangères, on garde les secondes :
-- ce sont elles qui empêchent les orphelins. L'invariant est donc tenu à
-- l'écriture, dans `reportService.normalizeTarget` — seul chemin d'insertion.
--
-- `target_msg_id` est en ON DELETE SET NULL et non CASCADE : si la cascade
-- s'appliquait, supprimer le message signalé effacerait le signalement — la
-- personne visée n'aurait qu'à effacer son message pour effacer la plainte.
-- Le signalement survit donc à son objet ; l'écran de modération devra dire
-- « message supprimé » plutôt que de faire disparaître la ligne.
--
-- `message.msgID` est BIGINT **signé** (jamais passé UNSIGNED) : toute clé
-- étrangère vers lui doit l'être aussi, sinon erreur 3780.
CREATE TABLE IF NOT EXISTS report (
  id             BIGINT      NOT NULL AUTO_INCREMENT,
  reporter_id    INT         NOT NULL,
  target_type    ENUM('message','user') NOT NULL,
  target_msg_id  BIGINT      NULL,
  target_user_id INT         NULL,
  reason         VARCHAR(32) NOT NULL COMMENT 'clé de motif, libellée côté client',
  note           VARCHAR(500) NULL COMMENT 'précision libre laissée par l''auteur du signalement',
  state          ENUM('open','reviewing','actioned','dismissed') NOT NULL DEFAULT 'open',
  created_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),

  -- La file de modération se lit « les plus anciens d'abord, parmi les ouverts ».
  KEY idx_report_state_date (state, created_at),
  -- « Ce compte a-t-il déjà été signalé ? » sur la fiche utilisateur.
  KEY idx_report_target_user (target_user_id, created_at),
  KEY idx_report_reporter (reporter_id, created_at),

  -- Un même auteur ne signale qu'une fois la même cible. Les NULL ne se
  -- heurtent jamais dans un index unique MySQL : un signalement de message
  -- (target_user_id NULL) n'empêche donc pas les suivants, et réciproquement.
  UNIQUE KEY uq_report_msg (reporter_id, target_msg_id),
  UNIQUE KEY uq_report_user (reporter_id, target_user_id),

  CONSTRAINT fk_report_reporter FOREIGN KEY (reporter_id)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_report_target_user FOREIGN KEY (target_user_id)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_report_target_msg FOREIGN KEY (target_msg_id)
    REFERENCES message(msgID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  2. Ce que l'équipe en a fait
-- -------------------------------------------------------------
-- Un signalement peut être repris plusieurs fois — mis en revue, puis tranché,
-- parfois rouvert. On garde la suite des décisions, pas seulement la dernière :
-- c'est ce qui permet de répondre à « qui a classé sans suite, et quand ».
--
-- `admin_id` en ON DELETE SET NULL : le départ d'un administrateur ne doit pas
-- effacer l'historique des décisions qu'il a prises.
CREATE TABLE IF NOT EXISTS report_action (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  report_id  BIGINT      NOT NULL,
  admin_id   INT         NULL,
  action     VARCHAR(32) NOT NULL COMMENT 'reviewing | warned | restricted | banned | dismissed',
  note       VARCHAR(500) NULL,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_action_report (report_id, created_at),
  CONSTRAINT fk_report_action_report FOREIGN KEY (report_id)
    REFERENCES report(id) ON DELETE CASCADE,
  CONSTRAINT fk_report_action_admin FOREIGN KEY (admin_id)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  3. Vérifications
-- -------------------------------------------------------------
-- SHOW CREATE TABLE report\G
--   → attendre trois clés étrangères et `target_msg_id` en `bigint` signé,
--     comme `message.msgID`.
--
-- Rejeu : les deux CREATE sont en IF NOT EXISTS, la migration est rejouable.
