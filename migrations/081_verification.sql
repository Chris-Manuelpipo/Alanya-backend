-- Migration 081 : vérification d'identité — dossiers, pièces, journal d'accès
--
-- Volet 8 de la conception (révise le volet 5, dont la migration 027 n'a
-- jamais été appliquée). Appliquer après 080. Application manuelle ;
-- réexécutable sans erreur : CREATE TABLE IF NOT EXISTS, reprise gardée par
-- NOT EXISTS.
--
-- ── Ce que la coche devient ──
--
-- `users.verification_status` et `users.verified_until` ne se saisissent plus :
-- une seule fonction les écrit (src/services/billing/verification.js), à
-- partir du dernier dossier et des droits d'abonnement. Un dossier approuvé
-- ne suffit pas en phase payante : il faut aussi l'abonnement.
--
-- ── Écarts avec le volet 5 ──
--
-- - Statut 5 = révoqué, sur la ligne même de la décision révoquée, avec son
--   auteur et son motif : la révocation ne réécrit pas l'approbation.
-- - `name_at_approval` : le nom vérifié. Si le nom affiché en diffère, la
--   coche tombe jusqu'à un nouvel examen.
-- - Type de pièce 4 = selfie avec la pièce (remplace la preuve de notoriété).
-- - Le journal d'accès ne porte pas de clé étrangère vers l'administrateur :
--   elle bloquerait la suppression de son compte, ou effacerait la trace de
--   ses consultations.
--
-- ── Les pièces ne sont pas ici ──
--
-- Seule leur clé de stockage l'est. Les fichiers vivent chiffrés dans le
-- coffre (VAULT_DIR, hors de uploads/ qui est servi en statique), sous une clé
-- (VAULT_KEY) qui n'est pas en base.

CREATE TABLE IF NOT EXISTS verification_request (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID         INT          NOT NULL,
  target_type      TINYINT      NOT NULL DEFAULT 0
                     COMMENT 'Genre vise : 0=personnel 1=business',
  claimed_name     VARCHAR(160) NOT NULL COMMENT 'Nom affiche au depot',
  name_at_approval VARCHAR(160) NULL
                     COMMENT 'Nom verifie ; un autre nom affiche fait tomber la coche',
  status           TINYINT      NOT NULL DEFAULT 0
                     COMMENT '0=en attente 1=piece demandee 2=approuve 3=refuse 4=annule 5=revoque',
  reviewed_by      INT          NULL,
  decided_at       DATETIME     NULL,
  reason           VARCHAR(255) NULL COMMENT 'Motif du refus ou de la piece demandee',
  revoked_by       INT          NULL,
  revoked_at       DATETIME     NULL,
  revoke_reason    VARCHAR(255) NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vr_file (status, created_at),
  KEY idx_vr_user (alanyaID, id),
  CONSTRAINT fk_vr_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_vr_reviewer FOREIGN KEY (reviewed_by)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_vr_revoker FOREIGN KEY (revoked_by)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS verification_document (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  request_id   BIGINT       NOT NULL,
  doc_type     TINYINT      NOT NULL
                 COMMENT '0=registre commerce 1=piece identite 2=adresse 3=notoriete 4=selfie',
  storage_key  VARCHAR(255) NOT NULL COMMENT 'Chemin relatif du fichier chiffre dans le coffre',
  mime         VARCHAR(80)  NOT NULL,
  size_bytes   BIGINT       NOT NULL,
  sha256       CHAR(64)     NULL COMMENT 'Empreinte du clair, pour reperer un double envoi',
  -- L'échéance portée par la ligne : lisible par quiconque ouvre la table, et
  -- balayée par le même filet que les échéances d'abonnement.
  purge_after  DATETIME     NULL COMMENT 'Pose a la decision : +90 jours',
  purged_at    DATETIME     NULL,
  uploaded_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vd_request (request_id),
  KEY idx_vd_purge (purge_after, purged_at),
  CONSTRAINT fk_vd_request FOREIGN KEY (request_id)
    REFERENCES verification_request(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chaque ouverture d'une pièce par l'administration : qui, quand, d'où.
CREATE TABLE IF NOT EXISTS verification_document_access (
  id          BIGINT      NOT NULL AUTO_INCREMENT,
  document_id BIGINT      NOT NULL,
  admin_id    INT         NOT NULL,
  accessed_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip          VARCHAR(45) NULL,
  PRIMARY KEY (id),
  KEY idx_vda_doc (document_id, accessed_at),
  KEY idx_vda_admin (admin_id, accessed_at),
  CONSTRAINT fk_vda_doc FOREIGN KEY (document_id)
    REFERENCES verification_document(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reprise : une vérification posée à la main avant le dossier (carte Socle du
-- lot A) devient un dossier approuvé au nom actuel. Sans cela, le premier
-- recalcul retirerait la coche de ces comptes.
INSERT INTO verification_request
  (alanyaID, target_type, claimed_name, name_at_approval, status, decided_at, reason)
SELECT u.alanyaID,
       IF(u.account_type = 1, 1, 0),
       LEFT(COALESCE(u.nom, ''), 160),
       LEFT(COALESCE(u.nom, ''), 160),
       2,
       NOW(),
       'Reprise de la vérification posée à la main avant le dossier d''identité'
  FROM users u
 WHERE u.verification_status = 2
   AND NOT EXISTS (SELECT 1 FROM verification_request r WHERE r.alanyaID = u.alanyaID);
