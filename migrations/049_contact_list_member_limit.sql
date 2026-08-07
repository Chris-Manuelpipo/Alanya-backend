-- 049 — Limite de membres par liste (Confiance = 5) + colonne pour les défauts
--
-- Les listes Famille / Amis / Bureau / Confiance sont semées par
-- ensureDefaultContactLists() à l'inscription et au GET /contact-lists.

ALTER TABLE contact_list
  ADD COLUMN member_limit INT NULL DEFAULT NULL
  AFTER color;
