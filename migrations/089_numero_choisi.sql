-- Migration 089 : le numéro choisi — acheter un numéro Alanya à 8 chiffres
--
-- Appliquer après 088. Application MANUELLE, réexécutable sans erreur
-- (CREATE TABLE IF NOT EXISTS, MODIFY idempotent). AVANT le déploiement du
-- code qui s'en sert — l'inscription, elle, tolère l'absence des tables.
--
-- ── Un paiement sans plan ──
--
-- Jusqu'ici un paiement achetait toujours une période d'abonnement : `plan_id`
-- était obligatoire. L'achat d'un numéro n'a pas de plan ; ce qu'il achète se
-- lit dans `purpose` (3) et dans la commande qui pointe vers lui.
--
-- ── La commande ──
--
-- Une ligne par tentative : le numéro retenu, puis payé, puis appliqué (ou
-- abandonné). `active_phone` et `active_user` ne valent quelque chose que
-- pendant la mise de côté et le paiement (statuts 0 et 1) : leurs index
-- UNIQUE font tenir par la base les deux règles qui rendent le changement
-- infaillible — un numéro n'est retenu que par un compte à la fois, un compte
-- ne retient qu'un numéro à la fois. Hors de ces statuts ils sont NULL, et
-- MySQL admet autant de NULL qu'on veut sous un index UNIQUE.
--
-- Colonnes VIRTUAL, pas STORED : MySQL refuse un ON DELETE CASCADE sur la
-- colonne de base d'une colonne générée STORED (ER_CANNOT_ADD_FOREIGN), or
-- `alanyaID` doit suivre la suppression du compte. L'index d'une colonne
-- VIRTUAL est matérialisé : l'unicité est tenue de la même façon.
--
-- Une mise de côté échue (statut 0, `held_until` passé) n'est soldée par
-- aucun job : la prochaine mise de côté du même numéro ou du même compte la
-- passe à 3 dans sa propre transaction, avant son INSERT.
--
-- Le statut 4 (crédit) est le filet : le paiement a réussi mais le numéro
-- n'a pas pu être posé. L'utilisateur choisit un autre numéro sans repayer.
--
-- ── L'historique ──
--
-- Tout changement de numéro, acheté ou fait par un administrateur. C'est de
-- lui que se déduit la quarantaine de l'ancien numéro (90 jours).
--
-- Collation alignée sur `users` : les numéros s'y comparent à
-- `users.alanyaPhone`, et deux collations différentes feraient échouer la
-- comparaison (« Illegal mix of collations »).

ALTER TABLE payment
  MODIFY plan_id INT NULL,
  MODIFY purpose TINYINT NOT NULL DEFAULT 0
    COMMENT '0=souscription 1=renouvellement 2=renouvellement auto 3=numero Alanya';

CREATE TABLE IF NOT EXISTS alanya_phone_order (
  id              BIGINT      NOT NULL AUTO_INCREMENT,
  alanyaID        INT         NOT NULL,
  phone_canonical VARCHAR(8)  NOT NULL,
  status          TINYINT     NOT NULL DEFAULT 0
                    COMMENT '0=retenu 1=paiement en cours 2=applique 3=abandonne 4=credit',
  held_until      DATETIME    NOT NULL,
  payment_id      BIGINT      NULL,
  old_phone       VARCHAR(20) NULL,
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  applied_at      DATETIME    NULL,
  active_phone    VARCHAR(8)
                    GENERATED ALWAYS AS (IF(status IN (0, 1), phone_canonical, NULL)) VIRTUAL,
  active_user     INT
                    GENERATED ALWAYS AS (IF(status IN (0, 1), alanyaID, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_active_phone (active_phone),
  UNIQUE KEY uq_order_active_user (active_user),
  UNIQUE KEY uq_order_payment (payment_id),
  KEY idx_order_user (alanyaID, created_at),
  CONSTRAINT fk_order_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_order_payment FOREIGN KEY (payment_id)
    REFERENCES payment(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alanya_phone_history (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  alanyaID   INT         NOT NULL,
  old_phone  VARCHAR(20) NOT NULL,
  new_phone  VARCHAR(20) NOT NULL,
  source     TINYINT     NOT NULL COMMENT '0=achat 1=administrateur',
  order_id   BIGINT      NULL,
  changed_by INT         NULL,
  changed_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_history_old (old_phone, changed_at),
  KEY idx_history_user (alanyaID, changed_at),
  CONSTRAINT fk_history_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_history_order FOREIGN KEY (order_id)
    REFERENCES alanya_phone_order(id) ON DELETE SET NULL,
  CONSTRAINT fk_history_by FOREIGN KEY (changed_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
