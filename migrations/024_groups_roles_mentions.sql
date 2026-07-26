-- =============================================================
--  Migration 024 : groupes enrichis — rôles, réglages, mentions
-- =============================================================
-- Voir Talky/docs/groupes-plan.md.
--
-- Trois blocs indépendants :
--   1. conv_participants.role      → 0=membre 1=admin 2=propriétaire
--   2. conversation.*              → description, createdBy/At, updatedAt,
--                                    et les deux verrous de permission
--   3. message.mentions (JSON)     → ids mentionnés, sur le modèle de la
--                                    colonne `reactions` de la 019
--
-- Réexécution : ignorer les erreurs "Duplicate column name" si la migration a
-- déjà été appliquée (même convention que la 022 et la 023).
--
-- ⚠️ Le BACKFILL en fin de fichier n'est PAS optionnel : sans lui, tous les
-- groupes existants se retrouvent sans propriétaire, donc ingérables.

-- ── 1. Rôles ─────────────────────────────────────────────────

ALTER TABLE conv_participants
  ADD COLUMN role TINYINT NOT NULL DEFAULT 0
      COMMENT '0=membre 1=admin 2=proprietaire';

-- ── 2. Métadonnées et verrous de groupe ──────────────────────
--
-- createdBy / createdAt n'existaient pas : admin/groups.js les dérivait de
-- MIN(cp.joinedAt) et de members[0]. On les matérialise pour de bon.
-- updatedAt sert de garde anti-réordonnancement aux trames socket
-- `conversation:updated` côté client.

ALTER TABLE conversation
  ADD COLUMN description           VARCHAR(512) NULL,
  ADD COLUMN createdBy             INT          NULL,
  ADD COLUMN createdAt             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updatedAt             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                ON UPDATE CURRENT_TIMESTAMP,
  ADD COLUMN onlyAdminsCanSend     TINYINT      NOT NULL DEFAULT 0
      COMMENT 'Mode annonce : seuls role>=1 peuvent envoyer',
  ADD COLUMN onlyAdminsCanEditInfo TINYINT      NOT NULL DEFAULT 0
      COMMENT 'Nom / photo / description réservés à role>=1';

-- ON DELETE SET NULL et non CASCADE : la suppression d'un compte ne doit pas
-- emporter les groupes qu'il a créés.
ALTER TABLE conversation
  ADD CONSTRAINT fk_conv_created_by FOREIGN KEY (createdBy)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE SET NULL;

-- ── 3. Mentions ──────────────────────────────────────────────
--
-- Colonne JSON plutôt que table message_mention : MSG_SELECT fait `SELECT m.*`,
-- donc la colonne circule gratuitement dans message:received, getMessages et
-- /messages/sync sans toucher une seule projection. Même parti pris que la
-- colonne `reactions` (migration 019).
-- Format : [45, 46]  — ou la chaîne "all" pour un @Tous au-delà de 256 membres.

ALTER TABLE message
  ADD COLUMN mentions JSON NULL
      COMMENT 'ids des membres mentionnes dans ce message';

-- Le type 6 est désormais pris par les messages système de groupe
-- (changement de commentaire uniquement, aucune contrainte ajoutée).
ALTER TABLE message MODIFY COLUMN type SMALLINT NULL DEFAULT 0
  COMMENT '0=text 1=image 2=video 3=audio 4=file 5=location 6=system 7=contact';

-- =============================================================
--  BACKFILL — obligatoire, à exécuter dans la foulée
-- =============================================================

-- 1) createdAt = entrée du plus ancien participant. C'est l'heuristique que
--    admin/groups.js:21 appliquait déjà à la volée.
UPDATE conversation c
JOIN (
  SELECT conversID, MIN(joinedAt) AS firstJoin
  FROM conv_participants
  GROUP BY conversID
) f ON f.conversID = c.conversID
SET c.createdAt = f.firstJoin;

-- 2) createdBy = participant dont la LIGNE est la plus ancienne, MIN(id).
--    Pas MIN(joinedAt) : createGroup insère toujours le créateur en premier,
--    alors que joinedAt est à la seconde près et produit des ex æquo.
--    Si le créateur a déjà quitté, MIN(id) désigne le plus ancien membre
--    restant — propriétaire par défaut raisonnable, et le groupe redevient
--    administrable, ce qui est l'objectif.
UPDATE conversation c
JOIN (
  SELECT conversID, MIN(id) AS firstRow
  FROM conv_participants
  GROUP BY conversID
) f ON f.conversID = c.conversID
JOIN conv_participants owner ON owner.id = f.firstRow
SET c.createdBy = owner.alanyaID
WHERE c.isGroup = 1;

-- 3) Ce createdBy devient propriétaire.
UPDATE conv_participants cp
JOIN conversation c ON c.conversID = cp.conversID
SET cp.role = 2
WHERE c.isGroup = 1 AND c.createdBy = cp.alanyaID;

-- =============================================================
--  CONTRÔLE — doit renvoyer 0 ligne
-- =============================================================
-- SELECT c.conversID, c.GroupName
--   FROM conversation c
--   LEFT JOIN conv_participants cp
--          ON cp.conversID = c.conversID AND cp.role = 2
--  WHERE c.isGroup = 1 AND cp.alanyaID IS NULL;
