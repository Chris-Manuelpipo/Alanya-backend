-- 059 — Colonne générée indexée pour les réactions (audit scalabilité,
-- palier P1 tranche B). Voir docs/AUDIT_SCALABILITE_2026-08-06.md §3.3.
--
-- GET /conversations/:id/reactions filtrait avec
-- `reactions IS NOT NULL AND JSON_LENGTH(reactions) > 0`, non sargable :
-- full scan de tout l'historique de la conversation à chaque ouverture
-- d'écran. `has_reactions` est STORED : recalculée automatiquement à chaque
-- écriture de `reactions`, aucun changement requis côté code d'écriture.

ALTER TABLE message
  ADD COLUMN has_reactions TINYINT GENERATED ALWAYS AS
    (CASE WHEN reactions IS NOT NULL AND JSON_LENGTH(reactions) > 0 THEN 1 ELSE 0 END) STORED,
  ADD INDEX idx_message_conv_hasreactions (conversationID, has_reactions);
