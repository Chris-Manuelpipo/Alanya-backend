# Application de messagerie instantanée — Architecture E2EE

> Stack : **Node.js + React**, SGBD **MySQL**.
> Chiffrement : **E2EE style Signal** (Double Ratchet + X3DH) via `@signalapp/libsignal-client`.
> Historique : **persistant**, via double chiffrement (transport + coffre local).

---

## 1. Décisions d'architecture (tranchées)

| Décision | Choix | Raison |
|----------|-------|--------|
| Bibliothèque crypto | `@signalapp/libsignal-client` (côté client) | Vrai protocole Signal, audité. Ne **jamais** réimplémenter le Double Ratchet soi-même. |
| Rôle du serveur | *Zero-knowledge* | Il distribue les clés publiques et route/stocke du ciphertext. Il ne déchiffre rien. |
| Historique persistant | Double chiffrement | Message chiffré 1× par le ratchet (transport, forward secrecy) + archivé chiffré par une **clé de coffre** dérivée du mot de passe (jamais connue du serveur). |
| Stockage client | IndexedDB | Ratchet state + coffre local. **Jamais** localStorage pour les clés. |
| SGBD | MySQL / InnoDB | Driver `mysql2/promise`, requêtes préparées. |

### Principe directeur

Le serveur ne lit **jamais** l'intérieur de `ciphertext` ni de `archive_blob`. Ce sont des
blobs opaques. Toute la cryptographie vit côté client React.

```
┌─────────────────────┐     pubkeys      ┌──────────────────────────┐
│  Client React (Alice)│ ───────────────▶ │ Serveur Node (zero-know.) │
│  • libsignal         │                  │ • Key server (pubkeys)    │
│  • IndexedDB         │ ◀──ciphertext──▶ │ • WebSocket (routage)     │
└─────────────────────┘                  └────────────┬─────────────┘
                                                       │ ciphertext + métadonnées
                                                       ▼
                                          ┌──────────────────────────┐
                                          │ MySQL : ciphertext only   │
                                          └──────────────────────────┘
```

---

## 2. Ordre de construction recommandé

Chaque étape est **testable seule**. Ne pas sauter d'étape.

1. **Backend B1 + B2** (DB MySQL + REST auth/clés) — testable au curl/Postman.
2. **Frontend F1 + F2** (crypto + store IndexedDB) — **cœur névralgique**. Tester en local :
   générer une identité, chiffrer/déchiffrer entre deux instances de store.
3. **Backend B3** (WebSocket) + **Frontend F4** (transport) — faire transiter un 1er message
   chiffré bout-en-bout entre deux navigateurs.
4. **Frontend F3** (coffre) + `GET /messages/history` — ajouter la persistance d'historique.
5. **Frontend F5** (UI) — habiller le tout.

> ⚠️ Tant que l'étape 2 ne marche pas en local (chiffrement/déchiffrement entre deux stores),
> ne pas toucher au réseau.

---

## 3. Le défi de l'historique persistant + forward secrecy

La forward secrecy (Double Ratchet) **jette les clés après chaque message** : c'est ce qui
protège le passé en cas de compromission. Mais alors comment relire l'historique après
reconnexion ou changement d'appareil ?

**Solution retenue : double chiffrement.**

1. À la connexion, on dérive une **clé de coffre** depuis le mot de passe via **Argon2id**
   (paramètres lourds) + un `vault_salt` propre à l'utilisateur. Cette clé ne quitte
   **jamais** le client et n'est **jamais** envoyée au serveur.
2. Avant l'envoi, le message est chiffré une 2ᵉ fois avec cette clé (**AES-256-GCM**) →
   c'est l'`archive_blob`.
3. À la reconnexion, on récupère les `archive_blob` du serveur et on les déchiffre
   localement avec la clé de coffre.

Résultat : changement d'appareil ou vidage du cache → l'historique se reconstruit, et le
serveur n'a jamais rien pu lire.

> Le `vault_salt` est stocké côté serveur (il n'est pas secret). Seul le mot de passe l'est.

---

## 4. Sécurité — rappels

- `password_hash` (Argon2id) sert **uniquement** à l'authentification. Il ne sert **jamais**
  à dériver la clé de coffre (séparation des usages).
- Seules les **clés publiques** sont uploadées au serveur. Les clés privées ne quittent
  jamais l'appareil.
- Transport réseau toujours en **TLS** (WSS / HTTPS) — l'E2EE ne remplace pas TLS, il s'ajoute.
- Le store IndexedDB du ratchet doit persister entre rechargements de page, sinon le ratchet
  repart de zéro et casse les sessions.
