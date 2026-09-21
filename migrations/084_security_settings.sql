-- Migration 084 : `security_settings`, l'interrupteur du verrouillage d'appareil
--
-- Appliquer après 083. Application manuelle ; réexécutable sans erreur
-- (CREATE TABLE IF NOT EXISTS + INSERT IGNORE), sur le modèle de la migration
-- 080 qui porte l'interrupteur du payant.
--
-- ── Pourquoi une table et pas data/app-settings.json ──
--
-- Les réglages applicatifs (maintenance, nom, URL) vivent dans un fichier JSON
-- local, non versionné. Ce serait le pire support possible pour un verrou de
-- sécurité : dès qu'il y a deux instances du serveur, les fichiers divergent, et
-- un même utilisateur se retrouverait bloqué ou non selon l'instance qui répond
-- à sa connexion. La base est le seul endroit que toutes les instances voient.
--
-- ── Pourquoi une ligne unique ──
--
-- Il n'y a qu'un réglage global, pas un par compte : la contrainte `id = 1` en
-- fait une invariante du schéma plutôt qu'une convention que le code doit tenir.
--
-- ── Pourquoi 0 par défaut ──
--
-- Poser la migration ne doit rien changer au comportement de la connexion. Le
-- verrou ne s'arme que le jour où un super-admin le demande depuis le
-- back-office, et le code de lecture considère de son côté qu'une table absente
-- vaut 0 : une base incomplète ne peut pas verrouiller tout le monde dehors.

CREATE TABLE IF NOT EXISTS security_settings (
  id                     TINYINT   NOT NULL DEFAULT 1,
  device_binding_enabled TINYINT   NOT NULL DEFAULT 0
                           COMMENT '1 = la connexion par mot de passe exige un appareil déjà enrôlé',
  updated_at             DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT ck_security_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO security_settings (id, device_binding_enabled) VALUES (1, 0);
