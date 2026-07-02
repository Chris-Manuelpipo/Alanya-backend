# Chiffrement des messages de groupe — Sender Keys

> Suite de `ARCHITECTURE.md` et `IMPLEMENTATION.md`.
> Stack : backend **Node.js + MySQL**, frontend **Flutter/Dart**.
> Protocole : **Sender Keys** (le mécanisme de groupe de Signal), pour groupes **moyens à grands**.
> Le 1-à-1 (X3DH + Double Ratchet) fonctionne déjà et sert de socle à la distribution des clés.

---

## 1. Modèle mental (à garder en tête pour tout le fichier)

- **Une sender key PAR expéditeur**, pas une clé unique de groupe.
- Chaque membre chiffre ses propres messages avec **sa** sender key.
- Chaque membre détient N clés : la sienne (émission) + celles des N-1 autres (réception).
- La sender key est distribuée **une seule fois** à chaque autre membre, **via les canaux 1-à-1
  déjà chiffrés** (X3DH). C'est le seul endroit où le coût est en O(N).
- Ensuite : chiffrer **1×**, le serveur **diffuse** (fan-out) le même ciphertext à tous.

### Pourquoi Sender Keys plutôt que pairwise

Le pairwise (chiffrer N fois par message) est simple mais coûte O(N) **par message**.
Pour des groupes moyens à grands, ça explose. Sender Keys ramène le coût par message à O(1)
côté chiffrement ; le O(N) n'apparaît qu'à la distribution initiale et aux rotations.

---

## 2. Règle de sécurité NON négociable : la rotation des clés

**Quand un membre quitte ou est retiré du groupe, TOUS les membres restants régénèrent leur
sender key et la redistribuent.**

Sans ça, la personne partie garde les sender keys courantes et peut déchiffrer tous les
messages futurs qu'elle intercepterait. La rotation est ce qui donne la forward secrecy au
niveau du groupe. Elle n'est pas optionnelle.

Déclencheur : un **événement serveur** (`group:member_removed`), pas une décision locale.
Le serveur est la **source de vérité** de la composition du groupe.

---

## 3. BACKEND (Node.js + MySQL)

Le serveur reste **zero-knowledge** : il route, il ne déchiffre rien. Il gère uniquement des
**métadonnées** (qui est dans quel groupe) et le **fan-out** des ciphertexts.

### 3.1 — Schéma MySQL (nouvelles tables)

```sql
CREATE TABLE groups (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  created_by  BIGINT UNSIGNED NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE group_members (
  group_id  BIGINT UNSIGNED NOT NULL,
  user_id   BIGINT UNSIGNED NOT NULL,
  role      TINYINT NOT NULL DEFAULT 0,   -- 0=membre, 1=admin
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
) ENGINE=InnoDB;
```

Adapter la table `messages` existante pour porter un `group_id` optionnel :

```sql
ALTER TABLE messages
  ADD COLUMN group_id BIGINT UNSIGNED NULL AFTER recipient_id,
  ADD INDEX idx_group (group_id, created_at),
  ADD FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
```

> Un message est soit 1-à-1 (`recipient_id` renseigné, `group_id` NULL), soit de groupe
> (`group_id` renseigné). `ciphertext` reste opaque : c'est la sortie du `GroupCipher`.

### 3.2 — Endpoints REST (gestion de la composition)

| Méthode | Route | Rôle |
|---------|-------|------|
| `POST`   | `/groups` | Créer un groupe (créateur = admin), renvoie `group_id`. |
| `POST`   | `/groups/:id/members` | Ajouter un membre. |
| `DELETE` | `/groups/:id/members/:userId` | Retirer un membre → **émettre `group:member_removed`**. |
| `GET`    | `/groups/:id/members` | Lister les membres (source de vérité pour le fan-out). |
| `GET`    | `/groups/:id/messages` | Historique (archive_blob chiffrés par le coffre). |

Ces routes ne manipulent QUE des métadonnées. Jamais de contenu déchiffré.

### 3.3 — WebSocket (fan-out + relais)

- `group:message` → le serveur lit `group_members` du groupe, puis **push le même
  ciphertext** à chaque membre connecté. Les hors-ligne récupèrent via l'historique.
- Relais des `SenderKeyDistributionMessage` : ils transitent **dans les canaux 1-à-1**
  (donc chiffrés par le ratchet), le serveur les route comme des messages 1-à-1 normaux.
  Il ne sait pas que c'est une distribution de clé — c'est opaque.
- `group:member_removed` / `group:member_added` → événements poussés à tous les membres
  pour déclencher, côté client, la rotation (retrait) ou la distribution (ajout).

---

## 4. FRONTEND (Flutter/Dart)

> Package : `libsignal_protocol_dart` (expose `GroupSessionBuilder`, `GroupCipher`,
> `SenderKeyDistributionMessage`, `SenderKeyName`, et un `SenderKeyStore`).
> ⚠️ Vérifier l'API exacte de la version épinglée dans `pubspec.yaml` — les noms peuvent
> légèrement varier entre versions. Les signatures ci-dessous correspondent à l'API
> `GroupSessionBuilder` / `GroupCipher`.

### 4.1 — Le SenderKeyStore persistant

Comme le `SignalProtocolStore` du 1-à-1, mais pour les sender keys. À implémenter sur ta
base locale (SQLite/Drift ou le store déjà utilisé). Il stocke l'état des sender keys
par `SenderKeyName` (= couple groupe + adresse de l'expéditeur).

> Doit persister entre redémarrages, sinon les sender keys sont perdues et il faut tout
> redistribuer.

### 4.2 — Rejoindre / créer un groupe : générer et distribuer sa sender key

```dart
// Identifie l'expéditeur DANS ce groupe : (nom/ID du groupe, mon adresse Signal)
final senderKeyName = SenderKeyName(groupId, myAddress); // myAddress = SignalProtocolAddress

final builder = GroupSessionBuilder(senderKeyStore);

// 1. Créer MA sender key pour ce groupe → produit le message de distribution
final SenderKeyDistributionMessage skdm = await builder.create(senderKeyName);
final bytes = skdm.serialize();

// 2. Envoyer `bytes` à CHAQUE autre membre via la session 1-à-1 existante
//    (donc chiffré par le ratchet : on réutilise le encrypt() 1-à-1 qui marche déjà)
for (final member in otherMembers) {
  final sealed = await oneToOneEncrypt(member, bytes); // ta fonction 1-à-1 existante
  sendToServer(member, sealed, type: 'sender_key_distribution');
}
```

### 4.3 — Recevoir la sender key d'un autre membre

```dart
// Quand un message 1-à-1 de type 'sender_key_distribution' arrive :
final bytes = await oneToOneDecrypt(fromMember, sealed); // déchiffre le ratchet 1-à-1
final skdm = SenderKeyDistributionMessageWrapper.fromSerialized(bytes);

final senderKeyName = SenderKeyName(groupId, fromMemberAddress);
final builder = GroupSessionBuilder(senderKeyStore);
await builder.process(senderKeyName, skdm); // enregistre la sender key de ce membre
```

### 4.4 — Envoyer un message de groupe

```dart
final senderKeyName = SenderKeyName(groupId, myAddress);
final groupCipher = GroupCipher(senderKeyStore, senderKeyName);

final ciphertext = await groupCipher.encrypt(utf8.encode(plaintext));
sendToServer(groupId: groupId, ciphertext: ciphertext); // le serveur fait le fan-out
```

Le chiffrement est fait **une seule fois**, quel que soit le nombre de membres.

### 4.5 — Recevoir un message de groupe

```dart
// senderAddress = l'expéditeur du message (fourni par le serveur dans les métadonnées)
final senderKeyName = SenderKeyName(groupId, senderAddress);
final groupCipher = GroupCipher(senderKeyStore, senderKeyName);

final plaintext = utf8.decode(await groupCipher.decrypt(ciphertext));
```

Si `decrypt` échoue avec une erreur de type "no session / no sender key", c'est que la
distribution de la sender key de cet expéditeur n'a pas encore été reçue → il faut la
demander/attendre (voir piège n°1).

### 4.6 — Rotation (membre retiré)

Sur réception de l'événement serveur `group:member_removed` :

```dart
// 1. Régénérer MA sender key pour ce groupe
final senderKeyName = SenderKeyName(groupId, myAddress);
final builder = GroupSessionBuilder(senderKeyStore);
final skdm = await builder.create(senderKeyName); // nouvelle clé, remplace l'ancienne

// 2. La redistribuer à tous les membres RESTANTS (via 1-à-1), comme en 4.2
```

Chaque membre restant fait pareil. Le membre parti ne reçoit rien → il ne peut plus
déchiffrer les nouveaux messages.

---

## 5. Deux pièges classiques

### Piège 1 — Le message arrive avant la sender key de son expéditeur

Les messages de groupe et les distributions de clés voyagent par des canaux différents
(fan-out vs 1-à-1) et peuvent se croiser. Si un `group:message` d'Alice arrive avant que
sa `SenderKeyDistributionMessage` ait été traitée, `decrypt` échoue.

Solution : mettre le ciphertext **en file d'attente** et le rejouer une fois la sender key
de cet expéditeur enregistrée. Ne pas jeter le message.

### Piège 2 — Désynchronisation de la liste des membres

Le fan-out serveur se base sur `group_members`. Si un client croit que X est encore là
alors que le serveur l'a retiré, incohérence.

Solution : **le serveur est la source de vérité**. La rotation se déclenche sur l'événement
serveur `group:member_removed`, jamais sur une décision locale du client.

### Piège 3 — Nouveaux arrivants et historique

Un nouvel arrivant reçoit les sender keys **courantes** — il ne doit pas déchiffrer les
messages d'avant son arrivée. Comme les sender keys avancent par chaînage, l'état reçu ne
déchiffre qu'à partir du point d'entrée : correct par construction. Mais **ne pas** lui
rejouer d'anciens ciphertexts de groupe en clair de session ; l'historique de groupe se
gère avec le **coffre** (comme le 1-à-1, cf. `ARCHITECTURE.md §3`).

---

## 6. Ordre de construction (testable à chaque étape)

1. **Backend** : tables `groups` / `group_members` + endpoints CRUD + fan-out WebSocket.
   Tester le fan-out avec des messages **NON chiffrés** d'abord → vérifier que tous les
   membres reçoivent bien.
2. **Frontend** : `SenderKeyStore` persistant + génération/distribution des sender keys
   (4.1 → 4.3). Tester : deux membres échangent leurs sender keys via 1-à-1.
3. **Frontend** : chiffrement/déchiffrement de groupe (4.4 → 4.5). Tester un message de
   groupe bout-en-bout entre 3 membres.
4. **Frontend + backend** : rotation (4.6 + événement serveur). Tester : après retrait d'un
   membre, il ne peut plus déchiffrer les nouveaux messages.
5. Gérer les pièges (file d'attente, source de vérité serveur).

> La rotation (étape 4) est gardée pour la fin, mais **n'est pas optionnelle** : c'est elle
> qui rend le groupe réellement sûr.

---

## 7. Comment vérifier que le chiffrement de groupe marche

Même méthode que pour le 1-à-1 :

1. **Inspection MySQL** : envoyer un message de groupe reconnaissable, vérifier que
   `ciphertext` en base ne contient PAS le texte clair.
2. **Deux ciphertexts identiques diffèrent** : envoyer 2× le même texte → les ciphertexts
   stockés doivent différer (le chaînage de la sender key avance).
3. **Test de rotation** : retirer un membre, vérifier (avec ses clés) qu'il ne peut plus
   déchiffrer un message envoyé après son départ.
