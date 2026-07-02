# Chiffrement des médias — Envelope Encryption

> Suite de `ARCHITECTURE.md`, `IMPLEMENTATION.md`, `GROUPES_E2EE.md`.
> Stack : backend **Node.js + MySQL** (+ object storage), frontend **Flutter/Dart**.
> Principe : **envelope encryption** — le même patron que WhatsApp/Signal pour les pièces jointes.

---

## 1. Le principe (à garder en tête)

On ne chiffre **jamais** un fichier avec le ratchet (1-à-1) ni le GroupCipher (groupe) :
ils sont faits pour de petits messages texte, pas pour des Mo de binaire.

À la place :

1. Générer une **clé média jetable** (AES-256 + IV, aléatoires, à usage unique).
2. Chiffrer le fichier avec cette clé en **AES-256-GCM** → un blob opaque.
3. Uploader le blob chiffré vers l'**object storage**. Le serveur ne voit que du chiffré.
4. Faire voyager la **clé média + URL + hash** dans un **message déjà chiffré** :
   - destinataire unique → via le ratchet 1-à-1
   - groupe → via le GroupCipher (Sender Keys)

La clé média voyage **dans** le message E2EE, jamais en clair. Le serveur n'a jamais la clé,
donc ne peut jamais déchiffrer le fichier.

> **Point clé** : l'enveloppe est INDÉPENDANTE du canal. Le fichier est chiffré **une seule
> fois** ; seule la petite clé change de canal (1-à-1 ou groupe) selon la destination. Rien
> de spécifique aux médias n'est à réimplémenter pour les groupes.

---

## 2. Flux détaillé

### Envoi
```
fichier ─(clé média AES-256 aléatoire)─▶ AES-256-GCM ─▶ blob chiffré
                                                             │
                                     upload ────────────────▶ object storage → renvoie URL
                                                             │
message E2EE (ratchet ou GroupCipher) = { clé média, IV, URL, sha256(blob), mime, taille }
```

### Réception
```
message E2EE déchiffré → { clé média, URL, hash, ... }
        │
        ▼
télécharger le blob depuis l'URL → vérifier sha256 → AES-256-GCM decrypt (clé média) → fichier
```

---

## 3. BACKEND (Node.js + MySQL + object storage)

Le serveur reste **zero-knowledge**. Pour les médias il fait deux choses : stocker des blobs
opaques et délivrer des URLs. Il ne voit jamais la clé média.

### 3.1 — Stockage des blobs

Deux options :

- **Object storage dédié (recommandé)** : MinIO (self-host, compatible S3) ou un bucket S3.
  Idéal pour les gros fichiers, gère le streaming et décharge la base.
- **Simple dossier serveur + table de métadonnées** : plus simple pour démarrer, suffisant
  pour une v1, mais ne pas y stocker les gros fichiers en base directement.

> Ne **jamais** stocker le blob dans une colonne MySQL pour les gros médias (vidéos). MySQL
> pour les métadonnées, object storage pour les octets.

### 3.2 — Schéma MySQL (métadonnées uniquement)

```sql
CREATE TABLE media_blobs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uploader_id  BIGINT UNSIGNED NOT NULL,
  storage_key  VARCHAR(255) NOT NULL,        -- clé/chemin dans l'object storage
  sha256       BINARY(32) NOT NULL,          -- hash du BLOB CHIFFRÉ (intégrité)
  byte_size    BIGINT UNSIGNED NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
```

> La table ne contient **aucune** clé média ni contenu en clair. Que des métadonnées
> techniques sur un blob opaque. Le `mime`, la `taille` réelle, le nom du fichier voyagent
> chiffrés dans le message E2EE, pas ici (sinon fuite de métadonnées).

### 3.3 — Endpoints REST

| Méthode | Route | Rôle |
|---------|-------|------|
| `POST` | `/media/upload` | Reçoit le blob chiffré (multipart/stream), le pousse dans l'object storage, renvoie `{ id, storage_key }`. |
| `GET`  | `/media/:id` | Renvoie le blob chiffré (ou une URL présignée si S3/MinIO). |

Pour l'object storage, préférer des **URLs présignées** : le client uploade/télécharge
directement vers le storage, le serveur ne fait que signer. Ça évite de faire transiter les
gros fichiers par ton process Node.

---

## 4. FRONTEND (Flutter/Dart)

### 4.1 — Chiffrer et envoyer un média

```dart
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart'; // ou pointycastle

Future<void> sendMedia(File file, {required Destination dest}) async {
  final bytes = await file.readAsBytes();

  // 1. Clé média jetable + chiffrement AES-256-GCM
  final algorithm = AesGcm.with256bits();
  final mediaKey = await algorithm.newSecretKey();
  final secretBox = await algorithm.encrypt(bytes, secretKey: mediaKey);
  // secretBox = { nonce (IV), cipherText, mac }
  final blob = Uint8List.fromList(secretBox.concatenation()); // IV|cipher|mac

  // 2. Hash du blob chiffré (intégrité)
  final digest = await Sha256().hash(blob);

  // 3. Upload du blob chiffré → l'object storage renvoie un id/URL
  final uploaded = await uploadEncryptedBlob(blob); // POST /media/upload

  // 4. Construire l'enveloppe (petit JSON) à faire voyager chiffrée
  final envelope = {
    'mediaKey': base64Encode(await mediaKey.extractBytes()),
    'url': uploaded.url,
    'sha256': base64Encode(digest.bytes),
    'mime': lookupMimeType(file.path),
    'size': bytes.length,
    'name': p.basename(file.path),
    // + miniature chiffrée si image/vidéo (voir 4.3)
  };

  // 5. Envoyer l'enveloppe DANS le canal E2EE approprié
  final payload = utf8.encode(jsonEncode(envelope));
  if (dest.isGroup) {
    await sendGroupMessage(dest.groupId, payload); // GroupCipher (Sender Keys)
  } else {
    await sendOneToOne(dest.userId, payload);       // ratchet 1-à-1
  }
}
```

### 4.2 — Recevoir et déchiffrer un média

```dart
Future<File> receiveMedia(Map<String, dynamic> envelope) async {
  // 1. Télécharger le blob chiffré
  final blob = await downloadBlob(envelope['url']); // GET /media/:id

  // 2. Vérifier l'intégrité AVANT de déchiffrer
  final digest = await Sha256().hash(blob);
  if (base64Encode(digest.bytes) != envelope['sha256']) {
    throw Exception('Blob altéré — hash invalide');
  }

  // 3. Déchiffrer avec la clé média extraite de l'enveloppe
  final algorithm = AesGcm.with256bits();
  final mediaKey = SecretKey(base64Decode(envelope['mediaKey']));
  final secretBox = SecretBox.fromConcatenation(blob,
      nonceLength: 12, macLength: 16);
  final clear = await algorithm.decrypt(secretBox, secretKey: mediaKey);

  // 4. Écrire le fichier déchiffré localement
  return writeToCache(Uint8List.fromList(clear), envelope['name']);
}
```

### 4.3 — Miniatures (thumbnails)

La miniature d'une image/vidéo **doit être chiffrée elle aussi**, sinon elle révèle le
contenu du média. Comme elle est petite, l'inclure **directement dans l'enveloppe** (chiffrée
avec le message E2EE), pas comme un blob séparé :

```dart
'thumbnail': base64Encode(await generateThumbnail(file)), // dans le JSON de l'enveloppe
```

Elle profite alors du chiffrement du message, aucune clé ni upload séparé.

### 4.4 — Gros fichiers : chiffrement par chunks (streaming)

Pour une vidéo, **ne pas** charger tout en mémoire (`readAsBytes` sur 200 Mo → OOM sur
mobile). Chiffrer par morceaux :

- Découper le fichier en chunks (ex. 64 Ko – 1 Mo).
- Chiffrer chaque chunk en AES-GCM avec la même clé média mais un **IV/compteur distinct par
  chunk** (ne JAMAIS réutiliser un IV avec la même clé en GCM).
- Uploader/télécharger en streaming.

> Alternative : certaines versions de libsignal fournissent un format d'attachment streaming
> tout fait. Vérifier ce qu'expose la version épinglée avant de réimplémenter le découpage.

---

## 5. Pièges classiques

### Piège 1 — Réutilisation d'IV en GCM
Fatal pour la sécurité. Chaque chiffrement (ou chaque chunk) utilise un **IV unique**.
Pour les chunks : dériver l'IV d'un compteur, jamais deux fois le même avec la même clé.

### Piège 2 — Vérifier le hash APRÈS avoir tout téléchargé, avant de déchiffrer
Ne pas déchiffrer un blob dont le hash ne correspond pas. GCM détecte déjà l'altération via
son tag d'authentification, mais le hash permet de rejeter tôt un blob corrompu/tronqué.

### Piège 3 — Fuite de métadonnées côté serveur
Le nom du fichier, le vrai type MIME, la taille réelle sont des métadonnées sensibles → ils
voyagent **dans l'enveloppe chiffrée**, pas dans la table `media_blobs`. Le serveur ne connaît
que la taille du blob chiffré et son hash.

### Piège 4 — Nettoyage des fichiers déchiffrés
Les fichiers déchiffrés écrits en cache local doivent être protégés (stockage privé de l'app)
et nettoyés. Ne pas les laisser dans un dossier accessible aux autres apps.

---

## 6. Ordre de construction (testable à chaque étape)

1. **Backend** : `/media/upload` + `/media/:id` + stockage (dossier simple ou MinIO).
   Tester en uploadant/téléchargeant un blob quelconque (round-trip d'octets).
2. **Frontend** : chiffrer un petit fichier (image), l'uploader, le retélécharger, le
   déchiffrer, comparer au fichier d'origine (4.1 + 4.2). **Sans** encore passer par le
   canal E2EE — juste valider l'enveloppe crypto.
3. **Frontend** : faire voyager l'enveloppe dans le canal 1-à-1 (ratchet). Envoyer une image
   à un contact, la voir s'afficher déchiffrée chez lui.
4. **Frontend** : même chose via le canal groupe (GroupCipher). Réutilise tout le reste.
5. **Miniatures** (4.3) puis **streaming des gros fichiers** (4.4).

---

## 7. Comment vérifier que le média est bien chiffré

1. **Inspecter le blob stocké** : ouvrir le fichier dans l'object storage / le dossier
   serveur → ce doit être du binaire illisible, PAS l'image d'origine (l'ouvrir comme image
   doit échouer).
2. **Inspecter le message E2EE en base** : le `ciphertext` du message qui porte l'enveloppe
   ne doit PAS contenir la clé média en clair (base64 lisible) ni l'URL en clair.
3. **Test d'altération** : modifier un octet du blob stocké → le déchiffrement côté client
   doit échouer (tag GCM invalide ou hash non concordant).
