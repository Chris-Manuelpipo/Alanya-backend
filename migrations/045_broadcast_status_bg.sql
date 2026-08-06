-- Migration 045 : couleur de fond des diffusions de statut
--
-- Une diffusion `kind=1` crée une ligne `statut`, qui porte déjà
-- `backgroundColor`. Il manquait de quoi la choisir : la colonne restait NULL
-- et l'app retombait toujours sur son indigo de marque.
--
-- La colonne est portée par `broadcast` — et non lue depuis le `statut` créé —
-- pour la même raison que `content` et `media_url` : l'historique doit rester
-- lisible après l'expiration du statut, et une diffusion planifiée doit
-- transporter son réglage jusqu'à sa publication.

ALTER TABLE broadcast
  ADD COLUMN background_color VARCHAR(20) NULL COMMENT '#RRGGBB ; NULL = indigo de marque' AFTER media_url;
