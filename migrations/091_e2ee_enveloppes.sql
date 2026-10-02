-- Migration 091 : corps chiffré et enveloppes par appareil
--
-- Appliquer après 090. Application MANUELLE, réexécutable (CREATE TABLE IF
-- NOT EXISTS, ajout de colonne gardé par information_schema). AVANT le
-- déploiement du code : `message:send` écrit dans ces tables dès qu'un client
-- lui envoie un corps chiffré.
--
-- ── Le modèle : un corps, N enveloppes ──
--
-- Un message chiffré se range en deux morceaux.
--
-- Le CORPS est chiffré une seule fois, en AES-256-GCM, avec une clé de
-- contenu tirée au hasard pour ce message-là. Il vit dans `message_e2ee`.
--
-- Les ENVELOPPES portent cette clé de contenu, scellée séparément pour
-- chaque appareil destinataire. Une ligne par appareil, dans
-- `message_envelope`.
--
-- Pourquoi cette indirection plutôt que chiffrer le corps une fois par
-- appareil : un compte a plusieurs appareils, et écrire à quelqu'un c'est
-- sceller pour chacun des siens PLUS chacun des miens (sinon mon second
-- téléphone ne voit pas ce que j'écris du premier). Sans clé de contenu, un
-- message de 2 Ko envoyé dans un groupe de 200 membres à deux appareils
-- chacun s'écrirait 400 fois, soit 800 Ko pour un message. Avec elle, le
-- corps s'écrit une fois et seuls 32 octets scellés se répètent.
--
-- ── Pourquoi `message_crypto` (migration 064) n'est PAS réutilisée ──
--
-- Elle porte déjà `ciphertext` et `dr_nonce`, et la tentation était de la
-- reprendre. Deux raisons de ne pas le faire.
--
-- D'abord ses lignes. Elles viennent de la branche `chiffrement-messages`,
-- abandonnée, et sont illisibles sans son code. Les colonnes changeant de
-- sens, ces lignes deviendraient des corps que le serveur servirait comme
-- valides et qu'aucun client ne pourrait ouvrir — une panne indiscernable
-- d'un bogue de chiffrement, précisément là où le diagnostic est le plus
-- coûteux. Les effacer serait la bonne réponse, mais c'est irréversible et
-- personne ne sait aujourd'hui combien il y en a.
--
-- Ensuite son schéma : `dr_header` et `signal_message_type` appartiennent à
-- l'enveloppe, pas au corps, et `archive_blob` servait un coffre d'historique
-- que ce plan abandonne (l'historique voyage par la sauvegarde Drive).
--
-- `message_crypto` reste donc intacte et inerte. La supprimer est un geste à
-- part, à faire après comptage :
--
--   SELECT COUNT(*) FROM message_crypto;   -- puis, si c'est assumé :
--   DROP TABLE message_crypto;
--
-- ── `enc_version` sur `message` ──
--
-- 0 = clair (le comportement d'aujourd'hui), 1 = corps dans `message_e2ee`.
--
-- Une colonne et non la simple présence d'une ligne dans `message_e2ee` :
-- l'immense majorité des lectures de `message` n'ont pas à joindre une
-- seconde table pour savoir si `content` vaut quelque chose. Et certains
-- messages resteront en clair pour toujours — ceux que le SERVEUR compose,
-- qui n'ont aucun expéditeur pour tenir une clé : messages système de groupe
-- (type 6), bienvenue, diffusions, trajets, traces d'appel.

-- ── 1. Le drapeau sur `message` ──────────────────────────────────────────
--
-- Garde par information_schema : MySQL 8 n'a pas `ADD COLUMN IF NOT EXISTS`,
-- et cette migration doit pouvoir être relancée après une interruption.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
    AND COLUMN_NAME = 'enc_version');
SET @sql := IF(@has = 0, 'ALTER TABLE message
    ADD COLUMN enc_version TINYINT NOT NULL DEFAULT 0
      COMMENT ''0=clair 1=corps chiffre dans message_e2ee''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. Le corps chiffré ──────────────────────────────────────────────────
--
-- Une table à part et non une colonne de `message` : `message` est la table
-- la plus chaude du schéma, et l'audit de scalabilité du 06/08/2026 en avait
-- déjà sorti la vignette base64 pour cette raison (migration 060). Un
-- MEDIUMBLOB dans la ligne ferait payer son poids à tous les `SELECT m.*` des
-- aperçus, des accusés et des listes — qui n'ont que faire du corps.
--
-- Ce que `body` contient, le serveur ne le sait pas et n'a pas à le savoir :
-- c'est une charge utile JSON chiffrée, où le client range le texte, le nom
-- du fichier, la citation, la vignette et la clé du média. Les métadonnées
-- dont le serveur a besoin — type, URL du média pour la rétention, mentions
-- à ré-intersecter, dates, accusés — restent en clair sur `message`.
--
-- `nonce` en VARBINARY(12) : la taille exacte d'un nonce AES-GCM. Le nonce
-- n'est pas un secret, il doit juste ne jamais se répéter pour une même clé —
-- et comme la clé de contenu est neuve à chaque message, la contrainte est
-- tenue par construction.
CREATE TABLE IF NOT EXISTS message_e2ee (
  msgID      BIGINT        NOT NULL,
  body       MEDIUMBLOB    NOT NULL,
  nonce      VARBINARY(12) NOT NULL,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (msgID),
  CONSTRAINT fk_message_e2ee FOREIGN KEY (msgID)
    REFERENCES message(msgID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Les enveloppes ────────────────────────────────────────────────────
--
-- `wrapped_key` NULLABLE, et ce n'est pas un relâchement : un message de
-- GROUPE ne scelle rien. Sa clé de contenu se dérive de la chaîne
-- d'expéditeur que chaque membre détient déjà, et l'en-tête ne porte que le
-- compteur de la chaîne. Une enveloppe de groupe a donc un `header` et pas de
-- `wrapped_key` ; une enveloppe deux-à-deux a les deux. `env_type` dit
-- laquelle on lit.
--
-- `delivered_at` sert la purge, pas l'accusé de remise : les accusés vivent
-- sur `message.status` et n'ont pas changé. Une enveloppe remise ne sert plus
-- à rien — le destinataire a déchiffré et rangé le clair chez lui — mais on
-- la garde quelques jours au cas où il réinstalle avant d'avoir sauvegardé.
--
-- Le CORPS, lui, survit au message entier. Il ne coûte pas plus que `content`
-- ne coûtait, et le supprimer rendrait des lignes `message` vides dont
-- plusieurs chemins de lecture ne sauraient que faire.
CREATE TABLE IF NOT EXISTS message_envelope (
  msgID        BIGINT         NOT NULL,
  appareil_id  BIGINT         NOT NULL,
  -- En-tête du protocole, JSON opaque : clé DH éphémère et compteurs du
  -- cliquet, amorçage X3DH le cas échéant, ou compteur de chaîne pour un
  -- groupe. Public par construction — ce sont les données que le protocole
  -- publie, jamais une clé privée ni un fragment de clair.
  header       TEXT           NOT NULL,
  wrapped_key  VARBINARY(128) NULL,
  env_type     TINYINT        NOT NULL
                 COMMENT '1=amorcage X3DH 2=cliquet 3=chaine de groupe',
  created_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME       NULL,
  -- (msgID, appareil_id) et non l'inverse : la lecture du chemin critique est
  -- « les enveloppes de CES messages, pour MOI » (historique, delta de sync),
  -- et c'est l'ensemble de msgID qui est sélectif.
  PRIMARY KEY (msgID, appareil_id),
  -- Le balayage par appareil : ce qu'un appareil n'a pas encore reçu.
  KEY idx_envelope_appareil (appareil_id, delivered_at),
  -- La purge : remises depuis plus de 7 jours, non remises depuis plus de 30.
  KEY idx_envelope_purge (delivered_at, created_at),
  CONSTRAINT fk_envelope_msg FOREIGN KEY (msgID)
    REFERENCES message(msgID) ON DELETE CASCADE,
  -- Un appareil révoqué puis recréé reçoit un `id` neuf (voir
  -- `deviceSessionService`) : ses anciennes enveloppes partent avec la ligne
  -- morte, ce qui est exactement ce qu'on veut.
  CONSTRAINT fk_envelope_appareil FOREIGN KEY (appareil_id)
    REFERENCES appareils(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
