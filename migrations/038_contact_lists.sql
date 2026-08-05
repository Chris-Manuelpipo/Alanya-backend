-- Listes de contacts (Famille / Amis / Bureau…) — regroupement nommé des
-- contacts préférés, pour filtrer la liste et ouvrir un chat de groupe avec
-- toute une liste en un geste.
--
-- Modèle calqué sur `preferredContact` (001) et `conv_participants` :
-- appartenance MANY-TO-MANY — un contact peut être dans plusieurs listes.
-- La table ne porte QUE des liens : elle ne duplique aucune donnée de profil.
--
-- ⚠ Le plan d'origine numérotait cette migration 025 ; 025→037 étaient déjà
-- pris au moment de l'implémentation, d'où le 038.
--
-- ⚠ Les migrations sont appliquées À LA MAIN sur ce backend (pas de runner
-- dans package.json). Appliquer ce SQL AVANT de déployer le code : les
-- contrôleurs nomment ces deux tables.

CREATE TABLE IF NOT EXISTS contact_list (
  idList     BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID   INT          NOT NULL,               -- propriétaire de la liste
  name       VARCHAR(60)  NOT NULL,
  color      VARCHAR(9)   NULL,                   -- ex #RRGGBB pour la puce
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idList),
  UNIQUE KEY uq_list_name (alanyaID, name),
  KEY idx_list_owner (alanyaID),
  CONSTRAINT fk_list_owner FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contact_list_member (
  idList     BIGINT   NOT NULL,
  idFriend   INT      NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idList, idFriend),
  KEY idx_clm_friend (idFriend),
  CONSTRAINT fk_clm_list   FOREIGN KEY (idList)
    REFERENCES contact_list(idList) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_clm_friend FOREIGN KEY (idFriend)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
