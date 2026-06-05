-- =============================================================
--  Migration 006: Index de performance pour la page Analytics admin
--  Description: les agrégations de /api/admin/analytics groupent par
--               DATE() sur de gros volumes. message.sendAt n'a qu'un
--               index composite (conversationID, sendAt) inadapté au
--               GROUP BY global, et statut.createdAt n'est pas indexé.
-- =============================================================

-- -- Volume de messages par jour / par type / heatmap (filtre BETWEEN sur sendAt)
-- ALTER TABLE message
--   ADD INDEX IF NOT EXISTS idx_message_sendat (sendAt);

-- -- Stories créées par jour / par type (filtre BETWEEN sur createdAt)
-- ALTER TABLE statut
--   ADD INDEX IF NOT EXISTS idx_statut_createdat (createdAt);

-- -- Feed d'activité + filtre période sur les connexions (devices)
-- ALTER TABLE userAccess
--   ADD INDEX IF NOT EXISTS idx_useraccess_datelogin (dateLogin);

ALTER TABLE message ADD INDEX idx_message_sendat (sendAt);
ALTER TABLE statut ADD INDEX idx_statut_createdat (createdAt);
ALTER TABLE userAccess ADD INDEX idx_useraccess_datelogin (dateLogin);