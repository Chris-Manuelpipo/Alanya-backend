-- 066 — Reclustering de conv_participants sur (conversID, alanyaID) au lieu
-- d'un id synthétique (audit scalabilité, docs/AUDIT_SCALABILITE_2026-08-06.md
-- §8 P2). InnoDB clusterise physiquement les lignes sur la PK : aujourd'hui
-- l'ordre d'insertion (chronologique, toutes conversations mélangées)
-- disperse les participants d'une même conversation sur des pages
-- différentes. Reclustériser sur (conversID, alanyaID) les co-localise —
-- bénéfice direct pour le chemin le plus chaud sur cette table : le fan-out
-- de messages (`SELECT alanyaID FROM conv_participants WHERE conversID = ?`,
-- messageSend.js) et tous les attachParticipants*.
--
-- À 481 lignes, un ALTER TABLE direct suffit (quelques millisecondes) — pas
-- besoin de gh-ost. C'est justement le bon moment : gratuit maintenant,
-- coûteux plus tard. Vérifié avant application : aucune FK externe ne
-- référence conv_participants (information_schema.KEY_COLUMN_USAGE), donc la
-- colonne `id` peut être démise de primaire à secondaire sans casser de
-- contrainte. Les deux seuls usages de `id` dans le code
-- (conversationController.js:1205 succession de propriétaire de groupe,
-- admin/media.js:37 libellé de conversation 1-1) s'appuient uniquement sur
-- son caractère AUTO_INCREMENT comme tri stable — ils continuent de
-- fonctionner à l'identique, `id` restant indexé (juste plus en PK).
--
-- `idx_cp_user_conv (alanyaID, conversID)` reste inchangé : toujours
-- nécessaire pour « conversations d'un utilisateur » (GET /conversations)
-- et pour supporter la FK fk_cp_user. La nouvelle PK (conversID, alanyaID)
-- couvre fk_cp_conv (commence par conversID).

ALTER TABLE conv_participants
  DROP PRIMARY KEY,
  DROP INDEX uq_conv_user,
  ADD PRIMARY KEY (conversID, alanyaID),
  ADD UNIQUE KEY uq_cp_id (id);
