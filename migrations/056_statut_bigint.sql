-- 056 — statut.ID en BIGINT UNSIGNED (audit scalabilité, palier P1 tranche A)
-- Voir docs/AUDIT_SCALABILITE_2026-08-06.md §2.1 — statut.ID est un INT signé
-- (plafond 2,1 Md) : saturation estimée à ~14 mois à 5M utilisateurs avec les
-- statuts de bienvenue et de diffusion. 171 lignes en production au 06/08 :
-- ALTER direct, aucun outil d'online-schema-change nécessaire à ce volume.
--
-- ⚠️ Les migrations de ce dépôt sont appliquées à la main et divergent parfois
-- de la production : vérifier par SHOW CREATE TABLE avant d'exécuter.
--
-- 4 référençeurs de statut.ID confirmés par SHOW CREATE TABLE le 07/08/2026 :
--   statut_views.statutID   (FK fk_sv_statut,   migration 001)
--   statut_i18n.statut_id   (FK fk_statut_i18n, migration 053 — n'existait
--                             pas encore lors de l'audit du 06/08)
--   welcome_status_delivery.statut_id (FK fk_wsd_statut, migration 044)
--   broadcast.statut_id     (pas de FK,          migration 040)
--
-- Les 3 FK doivent être déposées avant d'élargir la PK référencée, puis
-- recréées à l'identique (mêmes noms de contrainte, même ON DELETE CASCADE).

ALTER TABLE statut_views            DROP FOREIGN KEY fk_sv_statut;
ALTER TABLE statut_i18n             DROP FOREIGN KEY fk_statut_i18n;
ALTER TABLE welcome_status_delivery DROP FOREIGN KEY fk_wsd_statut;

ALTER TABLE statut                  MODIFY ID        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE statut_views            MODIFY statutID  BIGINT UNSIGNED NOT NULL;
ALTER TABLE statut_i18n             MODIFY statut_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE welcome_status_delivery MODIFY statut_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE broadcast               MODIFY statut_id BIGINT UNSIGNED NULL;

ALTER TABLE statut_views ADD CONSTRAINT fk_sv_statut
  FOREIGN KEY (statutID) REFERENCES statut(ID) ON DELETE CASCADE;
ALTER TABLE statut_i18n ADD CONSTRAINT fk_statut_i18n
  FOREIGN KEY (statut_id) REFERENCES statut(ID) ON DELETE CASCADE;
ALTER TABLE welcome_status_delivery ADD CONSTRAINT fk_wsd_statut
  FOREIGN KEY (statut_id) REFERENCES statut(ID) ON DELETE CASCADE;
