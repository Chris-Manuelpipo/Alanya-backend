-- Migration 091 : clés publiques du chiffrement de bout en bout, par appareil
--
-- Appliquer après 090 (090_abonnement_v2). Application MANUELLE, réexécutable
-- sans erreur (CREATE TABLE IF NOT EXISTS). AVANT le déploiement du code qui
-- s'en sert :
-- les gardes de `routes/e2eeKeys.js` joignent ces tables à chaque publication
-- de bundle, et l'absence de table rendrait 500 au lieu de 404.
--
-- Rien de secret ici. Ce sont les clés PUBLIQUES, et elles seules. Les clés
-- privées restent sur l'appareil (base locale, chiffrée par une clé gardée
-- dans le Keystore / Keychain), ne transitent jamais par le réseau et ne
-- figurent pas dans la sauvegarde Drive. Le serveur ne fait que distribuer de
-- l'annuaire.
--
-- ── Pourquoi la clé primaire est l'APPAREIL, pas le compte ──
--
-- C'est la décision qui porte tout le reste. Un compte Alanya accepte
-- plusieurs appareils en même temps : enrôlement par QR depuis un téléphone
-- déjà connecté, mot de passe sur un second téléphone, réinscription de
-- secours (`appareils.login_method`, migrations 026 et 083). La propriété
-- d'appel se décide déjà par `appareilId`.
--
-- Une identité par COMPTE serait donc un piège : le second appareil écraserait
-- le bundle du premier, et toutes les sessions déjà établies avec le premier
-- deviendraient indéchiffrables — sans message d'erreur, sans retour
-- possible, et seulement pour les correspondants qui avaient eu la malchance
-- d'ouvrir une session avant le basculement.
--
-- Conséquence assumée : écrire à quelqu'un, c'est sceller la clé du message
-- pour CHACUN de ses appareils actifs, et pour chacun des miens — sinon mon
-- second téléphone ne verrait pas ce que j'écris depuis le premier.
--
-- ── Pourquoi l'ancien `signed_prekey` est conservé ──
--
-- Le signed prekey tourne tous les 30 jours. Mais un correspondant qui a
-- récupéré le bundle lundi peut n'envoyer son premier message que jeudi : son
-- amorçage X3DH est calculé sur le prekey qu'il a LU, pas sur celui du jour.
-- Jeter l'ancien à la rotation ferait échouer tous les amorçages en vol, et
-- l'échec serait silencieux (le destinataire n'a plus la clé privée
-- correspondante). Les trois colonnes `prev_*` gardent la version précédente ;
-- le client la retire au bout de 60 jours, bien au-delà de toute dérive
-- d'horloge ou de tout téléphone resté éteint.
--
-- ── Le format : celui du protocole Signal ──
--
-- Les clés sont produites par `libsignal_protocol_dart` côté application, et
-- leur forme sérialisée est celle de Signal : une clé publique Curve25519 de
-- 32 octets PRÉCÉDÉE d'un octet de type (0x05, « DJB »), soit 33 octets ; une
-- signature XEdDSA de 64 octets. Une SEULE clé d'identité par appareil : Signal
-- signe avec la clé Diffie-Hellman elle-même (XEdDSA), il n'y a pas de clé de
-- signature séparée. Une version antérieure de ce schéma en prévoyait deux ;
-- voir `E2EE_DEPLOIEMENT.md` si elle a déjà été jouée.
--
-- ── Pourquoi VARBINARY aux tailles exactes ──
--
-- La taille documente le protocole et la base refuse d'elle-même un client
-- qui enverrait plus long. VARBINARY et non BINARY : BINARY complète à droite
-- avec des zéros, ce qui transformerait silencieusement une clé tronquée en
-- clé valide-en-apparence. La clé trop COURTE, que MySQL laisserait passer,
-- est refusée par `src/utils/e2eeBundle.js`.

CREATE TABLE IF NOT EXISTS e2ee_device_keys (
  -- `appareils.id`, celui que porte le JWT sous le nom `appareilId`. Pas
  -- `device_id` (l'identifiant matériel) : seul `id` désigne une ligne, et
  -- c'est lui que suit la révocation.
  appareil_id            BIGINT        NOT NULL,
  -- Dénormalisé depuis `appareils` : « tous les bundles de ce compte » est la
  -- requête du chemin critique (une par message envoyé), et elle ne doit pas
  -- payer une jointure pour retrouver une colonne que la ligne connaît déjà.
  alanyaID               INT           NOT NULL,
  -- Distingue deux installations successives sur le même appareil physique.
  -- Sans lui, un correspondant ne saurait pas que la session qu'il garde en
  -- mémoire s'adresse à une installation qui n'existe plus.
  registration_id        INT UNSIGNED  NOT NULL,
  -- Clé d'identité Signal (Curve25519, 0x05 + 32 octets). Elle sert au
  -- X3DH ET à vérifier la signature du signed prekey (XEdDSA).
  identity_key           VARBINARY(33) NOT NULL,
  -- Ce que cette installation sait lire : 0 = rien encore (clés publiées,
  -- aucun déchiffrement), 1 = texte, 2 = médias, 3 = groupes.
  -- Un correspondant n'envoie une forme de message qu'aux appareils qui la
  -- comprennent tous ; c'est ce qui remplace un suivi des versions de
  -- l'application, que `appareils` ne fait pas. Une mise à jour de
  -- l'application republie son bundle avec sa nouvelle capacité.
  capacite               TINYINT       NOT NULL DEFAULT 0,
  signed_prekey_id       INT UNSIGNED  NOT NULL,
  signed_prekey          VARBINARY(33) NOT NULL,
  signed_prekey_sig      VARBINARY(64) NOT NULL,
  prev_signed_prekey_id  INT UNSIGNED  NULL,
  prev_signed_prekey     VARBINARY(33) NULL,
  prev_signed_prekey_sig VARBINARY(64) NULL,
  -- Date de la rotation qui a relégué l'ancien prekey. C'est d'elle que le
  -- client déduit les 60 jours au bout desquels il cesse de le publier.
  prev_retired_at        DATETIME      NULL,
  created_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (appareil_id),
  KEY idx_e2ee_keys_user (alanyaID),
  CONSTRAINT fk_e2ee_keys_appareil FOREIGN KEY (appareil_id)
    REFERENCES appareils(id) ON DELETE CASCADE,
  CONSTRAINT fk_e2ee_keys_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Clés à usage unique (X3DH) ───────────────────────────────────────────
--
-- Elles ajoutent un quatrième demi-échange à l'amorçage, et c'est ce
-- quatrième qui protège le premier message si la clé d'identité du
-- destinataire finit par fuiter. Chacune est servie à UN SEUL correspondant,
-- puis plus jamais.
--
-- ── Pourquoi `claimed_at` et non un drapeau `used` ──
--
-- Une date dit QUAND, et c'est ce dont la purge a besoin. Un drapeau ne dit
-- rien : on ne saurait pas distinguer une clé consommée hier d'une clé
-- consommée il y a un an, ni purger les unes sans les autres.
--
-- ── Pourquoi la ligne n'est pas supprimée à la consommation ──
--
-- Deux raisons. D'abord l'unicité : la contrainte `(appareil_id, key_id)` est
-- ce qui empêche un appareil de republier un `key_id` déjà servi, et
-- supprimer la ligne rendrait cette republication possible. Ensuite le
-- diagnostic : un client qui réclame deux fois le même bundle se voit dans
-- les lignes consommées, pas dans leur absence. Purge à 30 jours, par
-- `purgeRegistry`.
--
-- Le stock peut tomber à zéro sans rien casser : l'amorçage se fait alors sur
-- trois demi-échanges au lieu de quatre. C'est une dégradation, pas une
-- panne — mais le client doit regarnir, et c'est à quoi sert
-- `GET /api/e2ee/keys/state`.
--
-- ── Pourquoi `claimed_by` ──
--
-- Servir un bundle consomme une clé du destinataire. Sans plafond, un compte
-- qui partage une conversation avec quelqu'un peut vider son stock en boucle
-- (docs/e2ee, chapitres 16 et 20). Savoir QUI a consommé permet de plafonner
-- par paire, sur toutes les instances à la fois puisque c'est en base ; et au
-- delà du plafond, le bundle est servi SANS clé à usage unique plutôt que
-- refusé — la messagerie continue, seul le stock de la victime est épargné.

CREATE TABLE IF NOT EXISTS e2ee_one_time_prekeys (
  id          BIGINT        NOT NULL AUTO_INCREMENT,
  appareil_id BIGINT        NOT NULL,
  key_id      INT UNSIGNED  NOT NULL,
  public_key  VARBINARY(33) NOT NULL,
  claimed_at  DATETIME      NULL,
  -- alanyaID du compte à qui la clé a été servie.
  claimed_by  INT           NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_e2ee_otpk (appareil_id, key_id),
  -- Sert les deux lectures du stock : prendre la prochaine clé libre
  -- (`claimed_at IS NULL ... LIMIT 1 FOR UPDATE`) et compter le stock.
  KEY idx_e2ee_otpk_libre (appareil_id, claimed_at),
  -- Sert le plafond par paire : ce que ce compte a consommé dans l'heure.
  KEY idx_e2ee_otpk_consommateur (claimed_by, claimed_at),
  CONSTRAINT fk_e2ee_otpk_appareil FOREIGN KEY (appareil_id)
    REFERENCES appareils(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
