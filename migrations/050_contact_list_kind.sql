-- 050 — Identifiant stable des listes système (localisation côté client)
--
-- kind : family | friends | work | trust | NULL (liste personnalisée)
-- Le libellé affiché vient de l10n ; `name` reste un fallback interne.

ALTER TABLE contact_list
  ADD COLUMN kind VARCHAR(20) NULL DEFAULT NULL
  AFTER name;

ALTER TABLE contact_list
  ADD UNIQUE KEY uq_list_kind (alanyaID, kind);

UPDATE contact_list SET kind = 'family'  WHERE kind IS NULL AND name IN ('Famille', 'Family');
UPDATE contact_list SET kind = 'friends' WHERE kind IS NULL AND name IN ('Amis', 'Friends');
UPDATE contact_list SET kind = 'work'    WHERE kind IS NULL AND name IN ('Bureau', 'Work');
UPDATE contact_list SET kind = 'trust'   WHERE kind IS NULL AND name IN ('Confiance', 'Trust');
