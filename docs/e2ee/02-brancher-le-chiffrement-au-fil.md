# Chapitre 2 — Brancher le chiffrement au fil de discussion

> **Où nous en sommes.** Le chapitre 1 a montré qu'Alice peut écrire à Bob sans
> que le serveur comprenne. Mais c'était en marge du produit : un banc d'essai,
> pas une conversation. Ce chapitre raccorde le chiffrement au **vrai fil** —
> et la première question à trancher est la plus gênante.

---

## 1. La question gênante

Un message, dans notre base, c'est une ligne de `message` :

| colonne | rôle |
|---|---|
| `msgID` | son identité |
| `conversationID` | où il s'affiche |
| `senderID` | qui l'a écrit |
| `created_at` | où il se place dans le fil |
| `status` | envoyé, remis, lu |
| `replyToID` | à quoi il répond |
| **`content`** | **ce qu'il dit** |

Le chiffrement retire la dernière ligne de ce tableau. **Le serveur n'a plus le
droit de la remplir.**

Alors que faire de la ligne entière ?

### Trois réponses possibles

**A. Supprimer la ligne, tout mettre dans l'enveloppe.**
On perd l'ordre du fil, le statut, la réponse citée, les mentions — tout ce que
le serveur doit connaître pour que le produit fonctionne. Un fil chiffré
deviendrait un produit différent, bien plus pauvre.

**B. Mettre le chiffré dans `content`.**
Tentant : une seule table, rien à changer. **C'est le piège.** `content` est un
`VARCHAR(500)` lu par des dizaines de requêtes — aperçu de conversation,
recherche, notifications, export. Une seule d'entre elles oubliée afficherait du
charabia à la place d'un message, ou pire, traiterait du chiffré comme du texte.
Deux régimes dans la même colonne, c'est une confusion qui finira par arriver.

**C. Garder la ligne, vider `content`, mettre le texte dans l'enveloppe.** ✅

C'est ce que nous avons fait.

> **La ligne porte tout SAUF le contenu. L'enveloppe porte le contenu et rien
> d'autre.** Le client rapproche les deux.

---

## 2. Le lien

```
message                        e2ee_enveloppes
  msgID          ◄───────────── message_id
  content = NULL                corps    (chiffré, une par appareil)
  created_at                    destinataire_device
  senderID
  status
```

### Pourquoi `message_id` est nullable

Une enveloppe peut exister **sans** message — c'est le cas du banc d'essai, et ce
sera celui d'un futur échange de clés hors fil.

> ⚠️ Rendre la colonne obligatoire interdirait ces usages **sans rien protéger de
> plus**. Une contrainte qui ne défend rien n'est pas de la rigueur, c'est une
> gêne.

### Pourquoi la cascade

Supprimer un message emporte ses enveloppes. Les laisser derrière ne servirait à
personne : elles ne se rattachent plus à rien, et personne ne peut plus ni les
lire ni les situer dans le fil.

C'est vérifié par le contrôle ⑮ du banc.

---

## 3. Activer le chiffrement : une décision, pas un réglage

`POST /api/conversations/<id>/e2ee`

### 🔴 C'est à sens unique

Une fois chiffrés, les messages le **restent** : le serveur n'a pas de quoi les
rouvrir pour les reranger en clair.

Proposer un bouton « désactiver » laisserait croire qu'on peut revenir en
arrière. **On ne le peut pas.** Et un fil à moitié lisible est pire qu'un fil
dont on sait qu'il est fermé.

### On refuse si quelqu'un n'a pas de clés

Sans ce contrôle, la conversation basculerait et les messages de cette personne
**ne partiraient nulle part**. Elle écrirait dans le vide ; son correspondant
attendrait une réponse qui n'existe pas.

Mieux vaut refuser en le disant : `409 CLES_MANQUANTES`.

### On refuse les groupes, explicitement

> Signal chiffre un groupe **autrement** : par *Sender Keys*, un mécanisme
> distinct de celui des conversations à deux.

Activer un groupe avec le code actuel produirait un chiffrement **par paires**.
Ça marcherait à trois. Ça s'effondrerait à dix : chaque message serait chiffré
**N × M fois**, pour N membres ayant chacun M appareils.

Refuser avec un code explicite (`400 GROUPE_NON_SUPPORTE`) vaut infiniment mieux
que de laisser passer quelque chose qui fonctionne mal à grande échelle — c'est
le genre de défaut qui ne se révèle qu'en production, le jour où le groupe
grossit.

### L'activation est idempotente

Deux appareils du même compte peuvent activer en même temps. Une seconde demande
passe sans se plaindre, sinon le second appareil verrait une erreur pour une
action qui a réussi.

---

## 4. Le drapeau côté client

`e2eeActif` est ajouté à la charge des conversations.

> ⚠️ **Champ facultatif, volontairement.** Un client qui l'ignore continue
> exactement comme avant. C'est ce qui permet de déployer le serveur **avant** les
> clients, sans coordonner les deux déploiements — règle qui vaut pour tout ajout
> de contrat, et qu'on ne regrette jamais d'avoir suivie.

---

## 5. Ce que le banc vérifie maintenant

Quatre contrôles de plus, soit **22 en tout**, tous verts :

| | Contrôle |
|---|---|
| ⑬ | Activation : en clair au départ, activable, active, puis **idempotente** |
| ⑭ | **La ligne de message n'a pas de contenu**, l'enveloppe le porte et reste illisible |
| ⑮ | Supprimer le message emporte ses enveloppes (cascade) |
| ⑯ | Un groupe est refusé **en le disant** |

Le ⑭ est le cœur de ce chapitre. On relit la ligne **depuis la base** et on
vérifie deux choses :

```js
verifier(relue.content === null,            "aucun contenu en clair")
verifier(!corpsDechiffrable.includes("contenu"), "et le corps reste illisible")
```

---

## 6. L'erreur de ce chapitre

Cette fois, elle ne venait pas du code mais de **l'environnement**.

La base de développement `alanya_dev` était **en retard de six migrations**. Le
banc échouait sur :

```
The column `colonne` does not exist in the current database.
```

Message parfaitement inutile : il ne nomme pas la colonne manquante.

**La tentation** était de lancer `prisma db push` pour tout remettre d'aplomb
d'un coup. Je ne l'ai pas fait : le diff annonçait **une table supprimée et cinq
colonnes perdues**.

> **Leçon.** Sur une base qui contient des données, `db push` n'est pas un
> raccourci mais un pari. `prisma migrate diff` dit exactement ce qui serait
> détruit — le lire coûte trente secondes, et les migrations additives se
> rejouent une par une sans rien perdre.

C'est aussi ce qui rend la règle du chapitre 1 précieuse : **prouver chaque SQL
manuel par `migrate diff`**. Sans cette habitude, l'écart entre la base et le
schéma se découvre bien plus tard, et bien plus cher.

---

## 7. Ce qui reste avant que ce soit utilisable

Le socle est là et testé. **Le fil du web n'envoie pas encore chiffré** — c'est
l'étape suivante, et elle touche `sendChatMessage`, une fonction qui porte déjà
la file hors ligne, l'affichage optimiste et la remise par WebSocket.

L'ordre de marche :

1. **Envoi chiffré** dans le fil web, derrière `e2eeActif`.
2. **Réception** : relever les enveloppes, déchiffrer, rapprocher du message.
3. **L'écran** : dire à l'utilisateur que la conversation est chiffrée, et lui
   montrer le code de sécurité à comparer.
4. **Payer les dettes** du chapitre 1 — retrait des identités mortes,
   avertissement sur changement de clé, coffre en IndexedDB.
5. **Puis le mobile.**

> ⚠️ **Rappel de la dette la plus urgente** (chapitre 1, erreur n° 3) : rien ne
> retire une identité d'appareil. Tant que ce n'est pas fait, chaque message est
> chiffré pour une pile d'appareils morts, et le stock de pré-clés se vide pour
> rien. Ça ne gêne pas un banc d'essai. Ça gênera un vrai usage dès la première
> réinstallation.

---

*Chapitre suivant : l'envoi chiffré dans le fil, et ce qu'on montre à quelqu'un
dont la conversation vient de se fermer au serveur.*
