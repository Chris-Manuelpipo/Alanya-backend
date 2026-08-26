-- Migration 072 : journal des actions administrateur
--
-- Le panneau d'administration compte 54 routes. Il peut bannir un compte,
-- le supprimer définitivement (`DELETE FROM users`), effacer un groupe avec
-- l'intégralité de ses messages, et diffuser à tous les inscrits. Rien de tout
-- cela ne laissait de trace : pas de table, pas de ligne. Les deux seules
-- exceptions étaient accidentelles — `purge_runs.by_admin`, qui ne couvre que
-- les purges, et `users.exclude_reason`, qui garde le motif d'un bannissement
-- mais pas son auteur.
--
-- Pour un back-office qui donne accès à des conversations privées, ce n'est pas
-- une fonctionnalité manquante : le jour où un compte disparaît, personne ne
-- peut dire qui l'a supprimé ni pourquoi.
--
-- Ce que la table ne contient PAS, délibérément : le corps des requêtes. Une
-- seule route suffirait à rendre la table toxique — `PUT /admin/profile/password`
-- transporte un mot de passe en clair. Seuls `reason` et `note`, deux champs
-- explicitement destinés à être lus par un humain, sont recopiés.

CREATE TABLE IF NOT EXISTS admin_audit (
  id          BIGINT       NOT NULL AUTO_INCREMENT,

  -- ON DELETE SET NULL : le départ d'un administrateur ne doit pas effacer la
  -- trace de ce qu'il a fait. C'est même précisément à ce moment-là qu'on la
  -- consulte.
  admin_id    INT          NULL,

  -- Verbe métier, pas un chemin : `users.ban`, `groups.delete`,
  -- `broadcasts.send`. `unmapped` signale une route mutante qu'aucune entrée
  -- de la carte ne décrit — le trou devient une ligne au lieu d'un silence.
  action      VARCHAR(64)  NOT NULL,

  -- `route` garde la méthode et le motif de chemin (`POST /users/:id/ban`).
  -- Redondant avec `action` sur les routes cartographiées, indispensable sur
  -- les autres : sans lui, une ligne `unmapped` ne mène nulle part.
  route       VARCHAR(160) NOT NULL,

  target_type VARCHAR(32)  NULL COMMENT 'user, group, meeting, broadcast…',
  target_id   VARCHAR(64)  NULL COMMENT 'chaîne : toutes les cibles ne sont pas des entiers',

  reason      VARCHAR(500) NULL COMMENT 'motif saisi par l''administrateur, jamais le corps de la requête',
  ip          VARCHAR(64)  NULL,
  user_agent  VARCHAR(255) NULL,
  status_code SMALLINT     NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- « Qui a touché à ce compte ? », sur la fiche utilisateur.
  KEY idx_audit_target (target_type, target_id, created_at),
  -- « Qu'a fait cette personne ? », et la page Activité admin, qui se lit
  -- du plus récent au plus ancien.
  KEY idx_audit_admin_date (admin_id, created_at),
  KEY idx_audit_date (created_at),

  CONSTRAINT fk_admin_audit_admin FOREIGN KEY (admin_id)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  Vérifications
-- -------------------------------------------------------------
-- Après une action depuis le panneau :
--   SELECT admin_id, action, route, target_id, status_code, created_at
--   FROM admin_audit ORDER BY id DESC LIMIT 5;
--
-- Et pour voir les trous de la carte route → action :
--   SELECT route, COUNT(*) FROM admin_audit WHERE action = 'unmapped'
--   GROUP BY route ORDER BY 2 DESC;
--
-- Rejeu : CREATE TABLE IF NOT EXISTS, la migration est rejouable.
