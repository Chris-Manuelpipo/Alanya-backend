-- =============================================================
--  Migration 024 : groupes enrichis — rôles, réglages, mentions
-- =============================================================
-- Voir Talky/docs/groupes-plan.md.
--
--   1. conv_participants.role      → 0=membre 1=admin 2=propriétaire
--   2. conversation.*              → description, createdBy/At, updatedAt,
--                                    et les deux verrous de permission
--   3. message.mentions (JSON)     → ids mentionnés, sur le modèle de la
--                                    colonne `reactions` de la 019
--   4. filet 022                   → en FIN de fichier, voir plus bas
--
-- ─────────────────────────────────────────────────────────────
--  RÉEXÉCUTION — à lire avant de lancer
-- ─────────────────────────────────────────────────────────────
--
--   mysql -u<user> -p <base> --force < 024_groups_roles_mentions.sql
--
-- Le `--force` est OBLIGATOIRE en rejeu, et le fichier est écrit pour lui :
-- **une seule colonne par ALTER**. Un ALTER multi-colonnes est atomique — une
-- seule colonne déjà présente et AUCUNE des autres n'est créée, alors que
-- l'erreur ressemble à un simple doublon. C'est la convention de la 022, et
-- c'est ce qui rend les erreurs ci-dessous réellement bénignes.
--
-- Erreurs attendues et sans gravité lors d'un rejeu :
--   1060  Duplicate column name        → la colonne est déjà là
--   1826  Duplicate foreign key        → la contrainte est déjà là
--
-- Toute AUTRE erreur doit être examinée.
--
-- ⚠️ Le BACKFILL n'est pas optionnel : sans lui, tous les groupes existants se
-- retrouvent sans propriétaire, donc ingérables. Il est écrit pour être
-- rejouable sans effet de bord.

-- ── 1. Rôles ─────────────────────────────────────────────────

ALTER TABLE conv_participants
  ADD COLUMN role TINYINT NOT NULL DEFAULT 0
      COMMENT '0=membre 1=admin 2=proprietaire';

-- ── 2. Métadonnées et verrous de groupe ──────────────────────
--
-- createdBy / createdAt n'existaient pas : admin/groups.js les dérivait de
-- MIN(cp.joinedAt) et de members[0]. On les matérialise pour de bon.

ALTER TABLE conversation ADD COLUMN description VARCHAR(512) NULL;
ALTER TABLE conversation ADD COLUMN createdBy INT NULL;
ALTER TABLE conversation
  ADD COLUMN createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- DATETIME(3) et non DATETIME : cette colonne sert de garde d'ordonnancement
-- aux trames socket `conversation:updated`. À la seconde près, deux actions
-- d'administration rapprochées porteraient le même horodatage et le client ne
-- pourrait plus les départager.
ALTER TABLE conversation
  ADD COLUMN updatedAt DATETIME(3) NOT NULL
      DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

ALTER TABLE conversation
  ADD COLUMN onlyAdminsCanSend TINYINT NOT NULL DEFAULT 0
      COMMENT 'Mode annonce : seuls role>=1 peuvent envoyer';
ALTER TABLE conversation
  ADD COLUMN onlyAdminsCanEditInfo TINYINT NOT NULL DEFAULT 0
      COMMENT 'Nom / photo / description reserves a role>=1';

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

-- `conversation.lastMessageType` reçoit lui aussi la valeur 6 (postSystemMessage).
ALTER TABLE conversation MODIFY COLUMN lastMessageType SMALLINT NOT NULL DEFAULT 0
  COMMENT '0=text 1=image 2=video 3=audio 4=file 5=location 6=system 7=contact';

-- =============================================================
--  BACKFILL — obligatoire, rejouable
-- =============================================================

-- 1) createdAt = entrée du plus ancien participant. C'est l'heuristique que
--    admin/groups.js appliquait déjà à la volée. Volontairement SANS filtre
--    isGroup : pour une conversation 1-1, MIN(joinedAt) est aussi la date de
--    création, et c'est strictement meilleur que le DEFAULT CURRENT_TIMESTAMP
--    posé par l'ALTER, qui daterait tout du jour de la migration.
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
--    restant — propriétaire par défaut raisonnable.
--
--    `AND c.createdBy IS NULL` rend l'opération REJOUABLE : sans ce filtre, un
--    second passage écraserait la propriété des groupes créés depuis, et
--    surtout celle transférée par la succession de leaveGroup.
UPDATE conversation c
JOIN (
  SELECT conversID, MIN(id) AS firstRow
  FROM conv_participants
  GROUP BY conversID
) f ON f.conversID = c.conversID
JOIN conv_participants owner ON owner.id = f.firstRow
SET c.createdBy = owner.alanyaID
WHERE c.isGroup = 1 AND c.createdBy IS NULL;

-- 3a) Rétrograder tout propriétaire qui n'est PAS le createdBy courant.
--     Sans cette étape, un rejeu laisserait deux role=2 dans le même groupe,
--     chacun pouvant rétrograder l'autre.
UPDATE conv_participants cp
JOIN conversation c ON c.conversID = cp.conversID
SET cp.role = 1
WHERE c.isGroup = 1
  AND cp.role = 2
  AND (c.createdBy IS NULL OR c.createdBy <> cp.alanyaID);

-- 3b) Le createdBy devient propriétaire.
UPDATE conv_participants cp
JOIN conversation c ON c.conversID = cp.conversID
SET cp.role = 2
WHERE c.isGroup = 1 AND c.createdBy = cp.alanyaID;

-- =============================================================
--  4. FILET — colonnes de la 022, en FIN de fichier
-- =============================================================
--
-- `GET /conversations` projette désormais mutedUntil / muteForever /
-- mentionsOnly. Sur une base où la 022 n'aurait pas été appliquée, la LISTE DES
-- CONVERSATIONS entière tomberait en ER_BAD_FIELD_ERROR.
--
-- Ce bloc est EN DERNIER, et c'est délibéré : sur une base normale (022 déjà
-- appliquée) il échoue en 1060, et tout ce qui précède — rôles, colonnes,
-- backfill — a déjà été exécuté. Placé en tête, comme il l'était initialement,
-- il interrompait la migration entière sans `--force` et laissait croire
-- qu'elle était passée.

ALTER TABLE conv_participants ADD COLUMN mutedUntil DATETIME NULL;
ALTER TABLE conv_participants ADD COLUMN muteForever TINYINT NOT NULL DEFAULT 0;
ALTER TABLE conv_participants ADD COLUMN mentionsOnly TINYINT NOT NULL DEFAULT 0;

-- =============================================================
--  CONTRÔLE — doit renvoyer 0 ligne
-- =============================================================
--
-- Détecte les DEUX défauts : zéro propriétaire, et deux propriétaires. Les
-- conversations sans aucun participant sont exclues — elles survivent à la
-- suppression d'un compte et ne sont pas un défaut de backfill.
--
-- SELECT c.conversID, c.GroupName, COUNT(cp.alanyaID) AS membres,
--        SUM(cp.role = 2) AS proprietaires
--   FROM conversation c
--   JOIN conv_participants cp ON cp.conversID = c.conversID
--  WHERE c.isGroup = 1
--  GROUP BY c.conversID, c.GroupName
-- HAVING SUM(cp.role = 2) <> 1;
