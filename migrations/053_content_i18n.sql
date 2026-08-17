-- Migration 053 : contenu officiel multilingue (tables normalisées)
--
-- Remplace le stockage bilingue en dur — `broadcast.content_en`,
-- `statut.text_en`, `welcome_block.content_fr`/`content_en` (migrations 042 et
-- 043) — par des tables par locale. Motif : l'ajout du chinois exigeait sinon
-- une colonne `_zh` sur trois tables plus un onglet d'éditeur, et le problème
-- se serait reposé identiquement à chaque langue suivante.
--
-- Trois tables plutôt qu'une table polymorphe : une clé étrangère polymorphe
-- interdirait le ON DELETE CASCADE, et il faudrait purger les orphelins à la
-- main.
--
-- ⚠️ LES ANCIENNES COLONNES SONT CONSERVÉES ET RESTENT ALIMENTÉES pendant une
-- release (double écriture côté service). Elles ne seront supprimées que par
-- une migration ultérieure, une fois la lecture normalisée validée en prod.
-- C'est ce qui rend ce déploiement réversible.
--
-- ⚠️ Les migrations de ce dépôt sont appliquées à la main et divergent parfois
-- de la production : vérifier par SHOW CREATE TABLE avant d'exécuter.

-- =============================================================
--  1. Diffusions
-- =============================================================
CREATE TABLE IF NOT EXISTS broadcast_i18n (
  broadcast_id BIGINT     NOT NULL,
  locale       VARCHAR(8) NOT NULL,
  content      TEXT       NOT NULL,
  PRIMARY KEY (broadcast_id, locale),
  CONSTRAINT fk_broadcast_i18n FOREIGN KEY (broadcast_id)
    REFERENCES broadcast(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
--  2. Statuts officiels
-- =============================================================
-- `statut` porte AUSSI les statuts des utilisateurs ordinaires, qui n'ont
-- aucune traduction. On ne reprend donc que les lignes réellement bilingues
-- (text_en renseigné) : pour toutes les autres, la chaîne de repli atteindra
-- `statut.text`. Sans ce filtre, on créerait une ligne i18n par statut
-- utilisateur, pour rien.
CREATE TABLE IF NOT EXISTS statut_i18n (
  statut_id INT        NOT NULL,
  locale    VARCHAR(8) NOT NULL,
  text      TINYTEXT   NOT NULL,
  PRIMARY KEY (statut_id, locale),
  CONSTRAINT fk_statut_i18n FOREIGN KEY (statut_id)
    REFERENCES statut(ID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
--  3. Blocs de bienvenue (corps + libellés de boutons)
-- =============================================================
-- `field` vaut 'content' pour le corps, ou 'cta.<index>' pour le libellé du
-- bouton d'indice <index> (base 0) du bloc CTA.
--
-- C'est ce qui sort enfin les libellés de `cta_json`, où ils étaient codés en
-- `labelFr`/`labelEn` — un JSON déjà cassé une fois par la migration 042 et
-- réparé par la 046. Cette migration ne RÉÉCRIT PAS `cta_json` : elle se
-- contente d'en lire les libellés. La structure (action, target, ordre) y
-- reste, et l'éditeur d'administration réécrit les deux ensemble.
CREATE TABLE IF NOT EXISTS welcome_block_i18n (
  block_id BIGINT      NOT NULL,
  locale   VARCHAR(8)  NOT NULL,
  field    VARCHAR(48) NOT NULL DEFAULT 'content',
  value    TEXT        NOT NULL,
  PRIMARY KEY (block_id, locale, field),
  CONSTRAINT fk_welcome_block_i18n FOREIGN KEY (block_id)
    REFERENCES welcome_block(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
--  4. Reprise des données existantes
-- =============================================================
-- INSERT IGNORE partout : la migration est rejouable sans écraser une
-- traduction saisie après un premier passage.

-- 4.1 Diffusions — uniquement celles réellement bilingues.
INSERT IGNORE INTO broadcast_i18n (broadcast_id, locale, content)
SELECT b.id, 'fr', b.content
FROM broadcast b
WHERE b.content_en IS NOT NULL AND TRIM(b.content_en) <> ''
  AND b.content IS NOT NULL AND TRIM(b.content) <> '';

INSERT IGNORE INTO broadcast_i18n (broadcast_id, locale, content)
SELECT b.id, 'en', b.content_en
FROM broadcast b
WHERE b.content_en IS NOT NULL AND TRIM(b.content_en) <> '';

-- 4.2 Statuts officiels.
INSERT IGNORE INTO statut_i18n (statut_id, locale, text)
SELECT s.ID, 'fr', s.text
FROM statut s
WHERE s.text_en IS NOT NULL AND TRIM(s.text_en) <> ''
  AND s.text IS NOT NULL AND TRIM(s.text) <> '';

INSERT IGNORE INTO statut_i18n (statut_id, locale, text)
SELECT s.ID, 'en', s.text_en
FROM statut s
WHERE s.text_en IS NOT NULL AND TRIM(s.text_en) <> '';

-- 4.3 Corps des blocs de bienvenue.
INSERT IGNORE INTO welcome_block_i18n (block_id, locale, field, value)
SELECT wb.id, 'fr', 'content', wb.content_fr
FROM welcome_block wb
WHERE wb.content_fr IS NOT NULL AND TRIM(wb.content_fr) <> '';

INSERT IGNORE INTO welcome_block_i18n (block_id, locale, field, value)
SELECT wb.id, 'en', 'content', wb.content_en
FROM welcome_block wb
WHERE wb.content_en IS NOT NULL AND TRIM(wb.content_en) <> '';

-- 4.4 Libellés des boutons, extraits de cta_json.
--
-- FOR ORDINALITY est en base 1 ; on retire 1 pour retrouver l'indice du
-- tableau JSON, celui que le service et l'éditeur manipulent.
INSERT IGNORE INTO welcome_block_i18n (block_id, locale, field, value)
SELECT wb.id, 'fr', CONCAT('cta.', jt.pos - 1), jt.label_fr
FROM welcome_block wb,
     JSON_TABLE(wb.cta_json, '$.buttons[*]' COLUMNS (
       pos      FOR ORDINALITY,
       label_fr TEXT PATH '$.labelFr',
       label_en TEXT PATH '$.labelEn'
     )) AS jt
WHERE wb.cta_json IS NOT NULL
  AND jt.label_fr IS NOT NULL AND TRIM(jt.label_fr) <> '';

INSERT IGNORE INTO welcome_block_i18n (block_id, locale, field, value)
SELECT wb.id, 'en', CONCAT('cta.', jt.pos - 1), jt.label_en
FROM welcome_block wb,
     JSON_TABLE(wb.cta_json, '$.buttons[*]' COLUMNS (
       pos      FOR ORDINALITY,
       label_fr TEXT PATH '$.labelFr',
       label_en TEXT PATH '$.labelEn'
     )) AS jt
WHERE wb.cta_json IS NOT NULL
  AND jt.label_en IS NOT NULL AND TRIM(jt.label_en) <> '';

-- =============================================================
--  5. Contrôle de reprise
-- =============================================================
-- À exécuter après la migration : chaque compteur « manquant » doit valoir 0.
-- Un écart signale une reprise incomplète — ne pas passer en double écriture
-- tant qu'il n'est pas résolu.
--
--   SELECT
--     (SELECT COUNT(*) FROM broadcast b
--       WHERE b.content_en IS NOT NULL AND TRIM(b.content_en) <> ''
--         AND NOT EXISTS (SELECT 1 FROM broadcast_i18n t
--                          WHERE t.broadcast_id = b.id AND t.locale = 'en'))
--       AS diffusions_manquantes,
--     (SELECT COUNT(*) FROM statut s
--       WHERE s.text_en IS NOT NULL AND TRIM(s.text_en) <> ''
--         AND NOT EXISTS (SELECT 1 FROM statut_i18n t
--                          WHERE t.statut_id = s.ID AND t.locale = 'en'))
--       AS statuts_manquants,
--     (SELECT COUNT(*) FROM welcome_block wb
--       WHERE wb.content_fr IS NOT NULL AND TRIM(wb.content_fr) <> ''
--         AND NOT EXISTS (SELECT 1 FROM welcome_block_i18n t
--                          WHERE t.block_id = wb.id AND t.locale = 'fr'
--                            AND t.field = 'content'))
--       AS blocs_manquants,
--     (SELECT COUNT(*) FROM welcome_block_i18n WHERE field LIKE 'cta.%')
--       AS libelles_boutons_repris;
