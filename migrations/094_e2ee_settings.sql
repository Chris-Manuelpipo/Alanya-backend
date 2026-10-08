-- Migration 094 : l'interrupteur du chiffrement de bout en bout
--
-- Appliquer après 093. Application MANUELLE, réexécutable sans erreur
-- (CREATE TABLE IF NOT EXISTS, INSERT IGNORE). Elle peut être jouée avant ou
-- après le déploiement du code : `e2eeSettingsService` lit une table absente
-- comme « tout fermé ».
--
-- ── Pourquoi un interrupteur, et pourquoi tout fermé par défaut ──
--
-- `main` se déploie à chaque push. Le code du chiffrement y arrive donc bien
-- avant les applications capables de s'en servir, et il doit y rester inerte
-- tant que personne ne l'a ouvert. Deux crans, dans cet ordre :
--
--   1. `enrol_enabled` : les appareils de la cohorte publient leurs clés. Rien
--      ne change pour personne ; c'est l'annuaire qui se remplit.
--   2. `activate_enabled` : les conversations de la cohorte peuvent passer en
--      chiffré. C'est le premier cran visible.
--
-- Refermer `activate_enabled` arrête les NOUVELLES activations. Une
-- conversation déjà chiffrée le reste : ses messages ne sont lisibles que par
-- les appareils, et la rebasculer en clair sur la parole du serveur est
-- précisément ce qu'un client correct refuse (docs/e2ee, chapitre 21).
--
-- ── La cohorte ──
--
-- Deux façons d'en faire partie, cumulables :
--   - `cohort_ids` : liste explicite d'alanyaID (JSON), pour les comptes
--     internes des premières étapes ;
--   - `cohort_percent` : un pourcentage de tous les comptes, tirés par un
--     haché stable de l'alanyaID — le même compte reste dedans d'un palier à
--     l'autre, et passer de 10 à 50 % n'en fait sortir personne.

CREATE TABLE IF NOT EXISTS e2ee_settings (
  id               TINYINT  NOT NULL DEFAULT 1,
  enrol_enabled    TINYINT  NOT NULL DEFAULT 0
                     COMMENT '1 = les appareils de la cohorte publient leurs clés',
  activate_enabled TINYINT  NOT NULL DEFAULT 0
                     COMMENT '1 = les conversations de la cohorte peuvent passer en chiffré',
  cohort_percent   TINYINT  NOT NULL DEFAULT 0
                     COMMENT 'Part des comptes dans la cohorte, de 0 à 100',
  cohort_ids       TEXT     NULL
                     COMMENT 'JSON : alanyaID toujours dans la cohorte',
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                     ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT ck_e2ee_settings_singleton CHECK (id = 1),
  CONSTRAINT ck_e2ee_settings_percent CHECK (cohort_percent BETWEEN 0 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO e2ee_settings (id, enrol_enabled, activate_enabled, cohort_percent)
VALUES (1, 0, 0, 0);
