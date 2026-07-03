# Ajouts à la base `alanyBD2027` pour le chiffrement de bout en bout (E2EE)

Ce document recense toutes les tables et colonnes ajoutées à la base de données pour le
chiffrement (messages 1-à-1, groupes, médias), avec la justification de chaque ajout.
Le serveur reste **zero-knowledge** : il ne stocke et ne relaie que des clés publiques et
des blobs opaques, jamais de clé privée ni de contenu en clair.

Chaque section correspond à un fichier de migration dans `migrations/`.

---

## Migration 009 — `009_e2ee_schema.sql`

Socle du chiffrement 1-à-1 : X3DH (établissement de session) + Double Ratchet (chiffrement
des messages).

### Colonne ajoutée — `users.vault_salt`

```sql
ALTER TABLE users ADD COLUMN vault_salt BINARY(16) NULL;
```

**Justification** : le "coffre" (vault) est une seconde couche de chiffrement qui permet de
récupérer l'historique des messages sur un nouvel appareil. La clé de coffre est dérivée du
mot de passe de l'utilisateur via Argon2id, et cette dérivation a besoin d'un sel. Le sel
n'est pas secret (seul le mot de passe l'est) : il est généré côté serveur à l'inscription et
renvoyé au client, qui l'utilise pour dériver la clé — laquelle ne quitte jamais l'appareil.

### Table ajoutée — `prekey_bundles`

```sql
CREATE TABLE prekey_bundles (
  alanyaID         INT NOT NULL,
  registration_id  INT UNSIGNED,
  identity_key     VARBINARY(255) NOT NULL,   -- retirée en migration 010
  signed_prekey    VARBINARY(255) NOT NULL,
  signed_prekey_id INT UNSIGNED NOT NULL,
  signature        VARBINARY(255) NOT NULL,
  updated_at       DATETIME,
  PRIMARY KEY (alanyaID)
);
```

**Justification** : X3DH (le protocole d'établissement de session utilisé par Signal, et
repris ici) exige que chaque utilisateur publie un "bundle" de clés publiques pour que
n'importe qui puisse lui envoyer un premier message chiffré sans échange préalable. Cette
table stocke ces clés **publiques** (jamais de clé privée) : la clé d'identité, une clé
pré-signée (renouvelée périodiquement) et sa signature (preuve qu'elle appartient bien à
cette identité).

### Table ajoutée — `one_time_prekeys`

```sql
CREATE TABLE one_time_prekeys (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  alanyaID   INT NOT NULL,
  key_id     INT UNSIGNED NOT NULL,
  public_key VARBINARY(255) NOT NULL,
  used       TINYINT(1) DEFAULT 0,
  created_at DATETIME,
  UNIQUE KEY uq_user_key (alanyaID, key_id)
);
```

**Justification** : en plus du bundle principal, X3DH utilise des clés **à usage unique**
pour renforcer la confidentialité persistante (forward secrecy) du tout premier message
d'une conversation. Chaque utilisateur publie un stock de ces clés publiques ; le serveur
en distribue une différente à chaque nouvelle session et la marque `used` pour ne jamais la
réutiliser (consommation atomique via `SELECT ... FOR UPDATE`).

### Colonnes ajoutées — `message`

```sql
ALTER TABLE message
  ADD COLUMN ciphertext          MEDIUMBLOB NULL,
  ADD COLUMN archive_blob        MEDIUMBLOB NULL,
  ADD COLUMN signal_message_type TINYINT NULL;
```

**Justification** :
- `ciphertext` : le payload du message réellement chiffré (remplace `content` pour un
  message E2EE — `content` reste utilisé uniquement pour l'historique pré-E2EE).
- `archive_blob` : une copie du message re-chiffrée avec la clé de coffre (indépendante du
  ratchet, qui ne peut déchiffrer un message qu'une seule fois) — permet de restaurer
  l'historique sur un nouvel appareil.
- `signal_message_type` : distingue un message "prekey" (premier message d'une session,
  porte le bootstrap X3DH) d'un message "normal" (ratchet déjà établi), needed côté client
  pour savoir comment interpréter le header.

---

## Migration 010 — `010_e2ee_split_identity_keys.sql`

### Modification — `prekey_bundles`

```sql
ALTER TABLE prekey_bundles
  ADD COLUMN identity_key_dh   VARBINARY(255) NULL,
  ADD COLUMN identity_key_sign VARBINARY(255) NULL,
  MODIFY COLUMN registration_id INT UNSIGNED NULL;
ALTER TABLE prekey_bundles DROP COLUMN identity_key;
```

**Justification** : le client utilise en réalité **deux** clés d'identité distinctes (à la
manière de XEdDSA) : une clé X25519 pour le calcul Diffie-Hellman du X3DH
(`identity_key_dh`), et une clé Ed25519 pour vérifier la signature du signed prekey
(`identity_key_sign`). La colonne unique `identity_key` de la migration 009 ne permettait
pas cette distinction — remplacée par les deux colonnes dédiées.

---

## Migration 011 — `011_e2ee_dr_header.sql`

### Colonnes ajoutées — `message`

```sql
ALTER TABLE message
  ADD COLUMN dr_nonce  VARBINARY(16) NULL,
  ADD COLUMN dr_header TEXT NULL;
```

**Justification** : le Double Ratchet a besoin, pour chaque message, du nonce AES-GCM et
d'un header (clé Diffie-Hellman éphémère publique + compteurs `n`/`pn` de la chaîne de
clés). Ces deux données sont publiques au sens du protocole (jamais la clé privée ni le
contenu), mais **indispensables** au déchiffrement — sans elles, un message reçu ne peut
tout simplement jamais être déchiffré. Bug critique corrigé par cette migration : ces
champs existaient côté client mais n'étaient ni stockés ni relayés par le serveur.

---

## Migration 012 — `012_media_e2ee_schema.sql`

### Table ajoutée — `media_blobs`

```sql
CREATE TABLE media_blobs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uploader_id  INT NOT NULL,
  storage_key  VARCHAR(255) NOT NULL UNIQUE,
  sha256       BINARY(32) NOT NULL,
  byte_size    BIGINT UNSIGNED NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Justification** : chiffrement des médias (photos, vidéos, audio, fichiers) par
"envelope encryption" — le fichier est chiffré côté client (AES-256-GCM, clé jetable) AVANT
l'upload. Cette table ne stocke que des **métadonnées techniques sur un blob opaque** :
qui l'a uploadé, où il est stocké sur disque (`storage_key`), son hash (intégrité) et sa
taille. Ni la clé de déchiffrement, ni le nom réel du fichier, ni son type MIME, ni son
contenu ne transitent par cette table — ces informations voyagent uniquement dans
l'enveloppe chiffrée du message (colonne `ciphertext` ci-dessus).

---

## Hors périmètre chiffrement (mentionné pour information)

**Migration 013 — `013_message_client_id.sql`** (colonne `message.clientId`) : ajoutée le
même jour pour corriger un problème de fiabilité des envois (dédoublonnage des retries après
perte de l'accusé `message:sent`). Ce n'est **pas** lié au chiffrement — c'est une clé
d'idempotence applicative — mentionné ici uniquement pour éviter toute confusion en
consultant le schéma actuel de `message`.

**Chiffrement de groupe (Sender Keys)** : contrairement au 1-à-1, la distribution des clés
d'expéditeur de groupe est relayée de façon **éphémère** via l'événement socket
`group:key_distribution` — le serveur ne la persiste dans **aucune table MySQL**. Le stockage
des Sender Keys se fait uniquement côté client, dans la base locale SQLite (Drift) de
l'application Flutter (table `SenderKeyRows`), hors du périmètre de `alanyBD2027`.
