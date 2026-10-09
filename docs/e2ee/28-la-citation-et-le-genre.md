# Chapitre 28 — La citation et le genre

> **Où nous en sommes.** 06/10/2026. Les fils chiffrés transportent du texte
> (chapitres 1 à 22) et des médias (chapitres 23 à 27). Deux gestes ordinaires
> y étaient pourtant impossibles : **répondre** à un message, et **envoyer un
> contact**. Ce chapitre explique pourquoi, et comment la charge v2 a grandi
> sans casser les anciennes versions.
>
> Serveur `d6f1a99`, web `6f3876b`, mobile `7e5327d`.

---

## 1. Les symptômes

Le user, le 06/10 :

> « Le reply sur un message de toute forme ne marche pas. »
> « L'envoi des contacts ? J'espère que tu les as chiffrés. »

Deux défauts distincts :

| Geste | Ce qui se passait |
|---|---|
| Répondre | Le message partait, mais **sans citation** |
| Envoyer un contact | L'envoi **échouait** : rien ne partait |

Bonne nouvelle pour le second : rien n'est jamais parti en clair. Le serveur
refusait, ce qui était exactement son rôle.

## 2. La réponse : une précaution fondée sur une erreur

Sur le téléphone, la bulle d'un texte chiffré portait ce commentaire :

```dart
// ⚠️ Le chemin chiffré ne porte pas encore les réponses citées : la
// citation voyagerait en clair. On ne fait pas semblant.
replyToId: null,
```

Le raisonnement semblait prudent. Il était **faux**. Regardons ce qu'une
réponse transporte vraiment :

| Ce qui part | Ce qui ne part pas |
|---|---|
| L'**identifiant** du message cité (`replyToId`) | Le **texte** du message cité |

Le texte cité n'a jamais besoin de voyager : chaque appareil l'a **déjà**,
déchiffré, dans son propre cache. Il suffit de lui dire **lequel** afficher.

Et l'identifiant n'apprend rien au serveur qu'il ne sache déjà : il connaît
tous les messages du fil, par leur identifiant.

> **Leçon.** Avant de refuser une fonction « pour la sécurité », il faut
> écrire **ce qui part exactement**. Ici, la liste tenait en une ligne, et
> elle ne contenait rien de secret.

## 3. Où mettre l'identifiant cité ?

Deux endroits sont possibles. On utilise les deux, pour deux raisons
différentes.

### Sur la ligne du fil (en clair, pour le serveur)

`POST /api/conversations/:id/messages` reçoit `replyToId`. Le serveur le
vérifie (même conversation) et le range. C'est ce qui permet à un appareil
qui **recharge** le fil de retrouver la citation.

### Dans la charge chiffrée (champ `reponseA`)

Le destinataire reçoit le message par la **relève** des enveloppes. Or une
enveloppe ne porte que `messageId` : sans `reponseA`, la bulle ajoutée par la
relève n'avait **pas de citation**, jusqu'à la réouverture du fil.

Il y a aussi un argument de principe, le même qu'au chapitre 26 pour
l'identifiant du message : ce qui est **dans** le chiffré est hors de portée
du serveur. Il ne peut pas faire répondre un message à un autre.

## 4. Le contact : un refus légitime, mais une impasse

Un contact est un message de type `CONTACT`, dont `content` contient une
**fiche JSON** :

```json
{"v":1,"contacts":[{"name":"Jean","phones":["82312187"]}]}
```

Le téléphone l'envoyait par le temps réel, **en clair**. Dans un fil chiffré,
le serveur répond `CONVERSATION_CHIFFREE`. C'est la garde posée au
chapitre 26 : rien de lisible n'entre dans un fil chiffré.

Le refus était juste. Mais aucun autre chemin n'existait : le contact ne
pouvait **jamais** partir.

### Le correctif : une fiche est un texte comme un autre

On chiffre la fiche exactement comme un texte : elle va dans le champ
`texte` de la charge. Il reste à dire au destinataire que ce texte est une
fiche, d'où un second champ : `genre`.

| `genre` | Ce que `texte` contient |
|---|---|
| absent | un texte, ou la légende d'un média |
| `CONTACT` | la fiche JSON d'un ou plusieurs contacts |
| `LOCATION` | la fiche JSON d'une position |

### Ce qu'il a fallu changer côté serveur

La validation exigeait la fiche dans `content` pour un `CONTACT`. Or un
message chiffré n'a **pas** de contenu sur sa ligne. Le serveur accepte
désormais un `CONTACT` vide **seulement** quand `chiffre: true`.

Le serveur connaît donc le **type** (« c'est un contact »), mais pas la fiche.
C'est la même règle que pour les médias (décision du 03/10) : le type est
visible, le contenu ne l'est pas. La liste affiche « 👤 Contact » côté
serveur, et « 👤 Jean » sur l'appareil, qui a déchiffré la fiche.

## 5. Faire grandir un format sans casser l'existant

La charge v2 avant ce chapitre :

```json
{"v":2,"id":"…","texte":"…","media":{…}}
```

Après :

```json
{"v":2,"id":"…","texte":"…","media":{…},"reponseA":"…","genre":"CONTACT"}
```

Trois règles ont rendu ce changement sans risque.

**1. Un champ absent ne s'écrit pas.** Un texte sans citation produit
exactement la charge d'avant, octet pour octet. Le banc le vérifie.

**2. Un ancien lecteur ignore ce qu'il ne connaît pas.** `lireCharge` ne lit
que les champs qu'il attend. Un téléphone pas encore mis à jour verra au pire
la fiche d'un contact en texte JSON, jamais une erreur.

**3. Une valeur inattendue est ignorée, pas refusée.** Un `genre` inconnu
(une version future, un « SONDAGE ») est écarté, et le texte s'affiche tel
quel. Refuser l'enveloppe ferait perdre le message entier pour un détail.

⚠️ En revanche, la vérification de l'identifiant (chapitre 26) reste **stricte** :
une charge rattachée à un autre message est toujours refusée.

### Parité entre le web et le téléphone

Les deux clients écrivent les champs **dans le même ordre**. Le test mobile
contient la charge produite par le banc web, et vérifie que le téléphone :

- la **lit** correctement ;
- **écrit exactement la même chaîne** pour le même message.

## 6. Ne rien perdre en route

Le type et la citation doivent survivre à chaque étape où un message est
rangé :

| Étape | Web | Mobile |
|---|---|---|
| Relève | `ClairRecu.reponseA / genre` | `MessageClair.reponseA / genre` |
| Cache local | `entreeCacheDechiffree` | `rangeTexteDechiffre` |
| Archive | `MessageArchive.reponseA / genre` | entrées `'reponseA'`, `'genre'` |
| Restauration | même fonction que le cache | `restaurerDepuisArchive` |
| Liste | `apercuStructure` → « 👤 Jean » | `apercuStructure` → « 👤 Jean » |

Oublier une seule ligne de ce tableau, c'est un contact qui redevient du
JSON après un changement de téléphone, ou une réponse qui perd sa citation
au rechargement.

## 7. Ce qui a été prouvé, et ce qui reste

- Web : `scripts/e2ee-charge-reponse-genre.mjs`, 13 vérifications sur les
  vrais modules (compatibilité, aller-retour, valeurs écartées, cache).
- Mobile : `test/e2ee_charge_extras_test.dart` (parité avec le web, relève,
  liste) ; suite complète : 353 tests.
- Serveur : `tsc` sans erreur ; déployé.
- **Pas encore fait** : un échange réel entre deux appareils.

## 8. À retenir

- Une précaution de sécurité se justifie par **ce qui part réellement**.
  Écrivez-le avant de refuser une fonction.
- Un refus du serveur protège, mais il faut toujours offrir **un chemin qui
  passe**. Sinon, la fonction n'existe tout simplement pas.
- Pour faire grandir un format chiffré : champs **facultatifs**, **absents**
  quand ils sont vides, **ignorés** quand ils sont inconnus.
- Chaque nouveau champ doit être suivi à **chaque étape de rangement**.
