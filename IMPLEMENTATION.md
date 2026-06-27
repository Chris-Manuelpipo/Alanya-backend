# Plan d'implémentation — Backend & Frontend

> À lire avec `ARCHITECTURE.md`. Ce fichier détaille **quoi coder, où, dans quel ordre**.

---

## BACKEND (Node.js + MySQL)

Le serveur est volontairement « bête » : il distribue des clés publiques et route du
ciphertext. Aucune logique crypto sensible n'y vit.

### Dépendances

- `mysql2` (avec `mysql2/promise`) — driver, requêtes préparées. **Pas** le vieux `mysql`.
- `argon2` — hash des mots de passe (auth).
- `jsonwebtoken` — JWT pour l'auth REST + WebSocket.
- `ws` ou `socket.io` — WebSocket.
- `express` — API REST.

### B1 — Modèle de données (MySQL / InnoDB)

> Moteur **InnoDB** obligatoire (clés étrangères + transactions, nécessaires pour la
> consommation atomique des prekeys). Les blobs chiffrés sont du binaire → `BLOB`/`VARBINARY`.

```sql
CREATE TABLE users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,        -- Argon2id (auth uniquement)
  vault_salt    BINARY(16) NOT NULL,          -- sel pour la clé de coffre (côté client)
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE prekey_bundles (
  user_id          BIGINT UNSIGNED PRIMARY KEY,
  registration_id  INT UNSIGNED NOT NULL,
  identity_key     VARBINARY(255) NOT NULL,    -- clé publique
  signed_prekey    VARBINARY(255) NOT NULL,    -- clé publique
  signed_prekey_id INT UNSIGNED NOT NULL,
  signature        VARBINARY(255) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE one_time_prekeys (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  key_id     INT UNSIGNED NOT NULL,
  public_key VARBINARY(255) NOT NULL,
  used       TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_key (user_id, key_id)
) ENGINE=InnoDB;

CREATE TABLE messages (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sender_id    BIGINT UNSIGNED NOT NULL,
  recipient_id BIGINT UNSIGNED NOT NULL,
  ciphertext   MEDIUMBLOB NOT NULL,           -- chiffré par le ratchet (transport)
  archive_blob MEDIUMBLOB,                    -- chiffré par le coffre (historique)
  message_type TINYINT NOT NULL DEFAULT 1,    -- 1=prekey, 2=normal (libsignal)
  delivered    TINYINT(1) NOT NULL DEFAULT 0,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_recipient_undelivered (recipient_id, delivered),
  INDEX idx_conversation (sender_id, recipient_id, created_at)
) ENGINE=InnoDB;
```

**Notes de types MySQL :**
- Pas d'UUID natif. Si UUID souhaité → `BINARY(16)` + `UUID_TO_BIN()` / `BIN_TO_UUID()`.
- `TINYINT(1)` = booléen (MySQL n'a pas de vrai `BOOLEAN`).
- `MEDIUMBLOB` (16 Mo) pour autoriser les longs messages ; `BLOB` (64 Ko) sinon.

### B2 — API REST (auth + distribution de clés)

| Méthode | Route | Rôle |
|---------|-------|------|
| `POST` | `/auth/register` | Crée le user, stocke le hash Argon2id + génère `vault_salt`. |
| `POST` | `/auth/login` | Renvoie un JWT. |
| `POST` | `/keys/upload` | Dépose `prekey_bundle` + lot de one-time prekeys (clés **publiques**). |
| `GET`  | `/keys/:username/bundle` | Renvoie un bundle (identity + signed prekey + **une** one-time prekey marquée `used`). Permet X3DH hors-ligne. |
| `GET`  | `/keys/count` | Nombre de prekeys restantes → le client re-upload quand le stock baisse. |
| `GET`  | `/messages/history?with=:userId` | Renvoie les `archive_blob` pour reconstruire l'historique. |

#### Consommation atomique des prekeys (important)

Lire une one-time prekey + la marquer `used` doit être **atomique** (sinon donnée 2×) :

```sql
START TRANSACTION;
SELECT id, key_id, public_key FROM one_time_prekeys
  WHERE user_id = ? AND used = 0
  ORDER BY id LIMIT 1
  FOR UPDATE;                    -- verrouille la ligne
UPDATE one_time_prekeys SET used = 1 WHERE id = ?;
COMMIT;
```

Le `FOR UPDATE` empêche deux requêtes simultanées de saisir la même clé.

### B3 — WebSocket (routage temps réel)

- Authentifier le socket via le **JWT** à la connexion.
- À la connexion d'un user → flush des messages `delivered = 0` qui l'attendent.
- Événement `message:send` → stocker en DB (`ciphertext` + `archive_blob`) puis **push** au
  destinataire s'il est connecté.
- Événement `message:ack` → marquer `delivered = 1`.

> Le serveur ne lit jamais l'intérieur de `ciphertext` ni `archive_blob`.

---

## FRONTEND (React)

Toute la cryptographie vit ici. Découpage en modules.

### Dépendances

- `@signalapp/libsignal-client` — protocole Signal.
- `idb` (wrapper léger IndexedDB) ou IndexedDB brut.
- `argon2-browser` (ou `hash-wasm`) — dérivation de la clé de coffre.
- Client WebSocket (`socket.io-client` ou `ws` natif navigateur).

### F1 — Module crypto (`crypto/`)

Wrapper autour de `@signalapp/libsignal-client`. Expose une API propre :

- `generateIdentity()` → identity keypair, registration ID, signed prekey, lot de
  one-time prekeys.
- `buildSession(recipientBundle)` → X3DH, crée la session sortante.
- `encrypt(recipientId, plaintext)` → fait avancer le ratchet, renvoie le ciphertext.
- `decrypt(senderId, ciphertext)` → déchiffre et fait avancer le ratchet.

### F2 — Store du ratchet (`store/`)

libsignal attend un **SignalProtocolStore** persistant (il y lit/écrit sessions, clés,
ratchet state). À implémenter sur **IndexedDB**. Interface attendue par la lib :
`loadSession`, `storeSession`, `loadIdentityKey`, `loadPreKey`, `storePreKey`,
`loadSignedPreKey`, etc.

> Sans persistance → le ratchet repart de zéro à chaque rechargement de page → casse.

### F3 — Le coffre d'historique (`vault/`)

Résout la contrainte « historique persistant » (voir `ARCHITECTURE.md §3`).

1. À la connexion : dériver la **clé de coffre** depuis le mot de passe (Argon2id, params
   lourds) + `vault_salt`. Ne quitte jamais le client.
2. Avant envoi : chiffrer le message une 2ᵉ fois (AES-256-GCM via WebCrypto) → `archive_blob`.
3. À la reconnexion : récupérer les `archive_blob` et les déchiffrer localement.

### F4 — Couche transport (`transport/`)

Client WebSocket + appels REST. Sérialise/désérialise, gère la reconnexion, fait le pont
entre le module crypto et le réseau.

### F5 — UI React (`components/`)

Liste de conversations, fenêtre de chat, indicateurs de livraison. La UI ne manipule que du
**plaintext déjà déchiffré** — elle ne touche jamais aux clés directement.

---

## Récapitulatif des modules

| Côté | Module | Responsabilité | Voit le clair ? |
|------|--------|----------------|-----------------|
| Front | `crypto/` | libsignal : ratchet, X3DH | ✅ |
| Front | `store/` | SignalProtocolStore sur IndexedDB | ✅ (clés) |
| Front | `vault/` | Coffre d'historique (AES-GCM) | ✅ |
| Front | `transport/` | WebSocket + REST | ❌ (blobs) |
| Front | `components/` | UI React | ✅ (plaintext) |
| Back | REST | Auth + distribution de clés | ❌ |
| Back | WebSocket | Routage ciphertext | ❌ |
| Back | MySQL | Stockage ciphertext + métadonnées | ❌ |
