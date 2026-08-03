-- « Ajouter à l'appel » (transfert assisté) : traçabilité d'un appel à trois.
--
-- callHistory est binaire (un appelant, un destinataire) et le reste : on écrit
-- une ligne par paire RÉELLEMENT connectée, et les lignes d'une même session
-- partagent un sessionID. Un appel à trois produit donc trois lignes — l'appel
-- d'origine, la paire invitant/invité, la paire invité/autre participant.
--
-- C'est ce qui garde l'historique de chacun juste, y compris celui de deux
-- personnes qui ont continué à parler après le départ d'un tiers.
--
-- Migration additive et rétrocompatible : les lignes existantes conservent
-- sessionID = NULL et s'affichent exactement comme avant.

ALTER TABLE callHistory
  ADD COLUMN sessionID VARCHAR(64) NULL DEFAULT NULL
  COMMENT 'Session d''appel à trois ; NULL pour un appel 1-à-1 ordinaire';

-- Regroupement des lignes d'une même session à l'affichage du journal d'appels.
CREATE INDEX idx_call_session ON callHistory(sessionID);
