-- 067 — Clés étrangères manquantes sur broadcast_delivery, welcome_delivery
-- et broadcast (audit scalabilité, docs/AUDIT_SCALABILITE_2026-08-06.md §2.6).
-- Ces tables n'avaient aucune contrainte sur alanyaID/conversID/msgID/
-- sender_id/created_by/statut_id : accountDeletionService._purgeUser ne les
-- nettoyait pas, donc chaque suppression de compte laissait des lignes
-- orphelines s'accumuler silencieusement. La purge de rétention (058) crée
-- elle-même des orphelins actifs sur broadcast.statut_id à chaque suppression
-- d'un statut expiré.
--
-- Nettoyage préalable requis (MySQL refuse d'ajouter une FK en présence
-- d'orphelins) : vérifié en production le jour de cette migration —
-- 1 ligne orpheline sur welcome_delivery.alanyaID (utilisateur déjà
-- supprimé), 2 lignes sur broadcast.statut_id (statuts déjà purgés par 058).
-- Idempotent : ces DELETE/UPDATE ne trouvent plus rien si déjà exécutés.

DELETE wd FROM welcome_delivery wd
  LEFT JOIN users u ON u.alanyaID = wd.alanyaID
  WHERE u.alanyaID IS NULL;

UPDATE broadcast b
  LEFT JOIN statut s ON s.ID = b.statut_id
  SET b.statut_id = NULL
  WHERE b.statut_id IS NOT NULL AND s.ID IS NULL;

-- ⚠️ Correction d'un désaccord de signe introduit par la migration 057 :
-- broadcast_delivery.conversID/msgID et welcome_delivery.conversID y avaient
-- été élargis en BIGINT UNSIGNED, mais conversation.conversID et
-- message.msgID sont des BIGINT SIGNÉS (jamais passés UNSIGNED — même piège
-- que message_thumb, migration 060). MySQL refuse une FK entre colonnes de
-- signe différent (erreur 3780) — constaté à l'exécution de cette migration.
-- Idempotent (MODIFY vers un type déjà en place ne fait rien).
ALTER TABLE broadcast_delivery
  MODIFY conversID BIGINT NULL,
  MODIFY msgID     BIGINT NULL;
ALTER TABLE welcome_delivery
  MODIFY conversID BIGINT NOT NULL;

-- broadcast.created_by (l'admin qui a déclenché la diffusion) doit pouvoir
-- survivre à la suppression de cet admin — devient nullable pour permettre
-- ON DELETE SET NULL, même convention que conversation.createdBy (001).
ALTER TABLE broadcast MODIFY created_by INT NULL;

-- broadcast_delivery : la ligne n'a de sens que pour un utilisateur existant
-- (CASCADE) ; conversID/msgID sont déjà nullables et purement informatifs,
-- SET NULL préserve le fait "livré" même si leur cible a depuis disparu.
ALTER TABLE broadcast_delivery
  ADD CONSTRAINT fk_bd_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT fk_bd_conversation FOREIGN KEY (conversID)
    REFERENCES conversation(conversID) ON DELETE SET NULL,
  ADD CONSTRAINT fk_bd_message FOREIGN KEY (msgID)
    REFERENCES message(msgID) ON DELETE SET NULL;

-- welcome_delivery : même raisonnement pour alanyaID. conversID reste
-- NOT NULL (pas de changement de nullabilité) : CASCADE plutôt que SET NULL.
ALTER TABLE welcome_delivery
  ADD CONSTRAINT fk_wd_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT fk_wd_conversation FOREIGN KEY (conversID)
    REFERENCES conversation(conversID) ON DELETE CASCADE;

-- broadcast : sender_id est toujours le compte officiel (vérifié dans
-- admin/broadcast.js : rejeté si différent de getOfficialAccountId()), déjà
-- protégé contre la suppression au niveau applicatif (admin/users.js,
-- OFFICIAL_NOT_DELETABLE) — RESTRICT (par défaut, sans ON DELETE) sert de
-- filet de sécurité, ne doit jamais se déclencher en pratique. created_by
-- (n'importe quel admin) doit survivre à la suppression de son auteur :
-- SET NULL. statut_id (déjà nullable, déjà UNSIGNED comme statut.ID) :
-- SET NULL, cohérent avec la purge automatique des statuts expirés.
ALTER TABLE broadcast
  ADD CONSTRAINT fk_broadcast_sender FOREIGN KEY (sender_id)
    REFERENCES users(alanyaID),
  ADD CONSTRAINT fk_broadcast_created_by FOREIGN KEY (created_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_broadcast_statut FOREIGN KEY (statut_id)
    REFERENCES statut(ID) ON DELETE SET NULL;
