# Chapitre 30 — Les délais, et ce qui sort du chiffrement

> **Où nous en sommes.** 07/10/2026, au soir. Le chapitre 29 a appris aux
> appareils à modifier et transférer un message chiffré. Trois choses sont
> venues s'y ajouter le même jour :
>
> - des **délais** : plus de modification 2 heures après l'envoi, plus de
>   suppression « pour tous » 24 heures après ;
> - le **web** modifie à son tour, avec le même protocole ;
> - le **partage**, vers une autre application et depuis une autre
>   application.
>
> Serveur `d7f027d`, mobile `d6f43a5` (et `c70dbb3` pour le partage), web
> `98db89c`.

---

## 1. Les délais : qui décide ?

La demande du user :

> « Fais aussi qu'il soit impossible de supprimer un message après 24 h pour
> tous, et impossible de modifier un message après 2 h. »

| Geste | Délai |
|---|---|
| Modifier | 2 heures après l'envoi |
| Supprimer pour tout le monde | 24 heures après l'envoi |
| Supprimer pour moi | aucun délai |

« Supprimer pour moi » n'a pas de délai : il ne touche que son propre écran,
et ne prive personne d'autre de rien.

### Le serveur tranche, sur SON horloge

Les clients masquent les boutons une fois le délai passé. Mais **l'horloge
d'un téléphone se règle à la main** : reculer l'heure suffirait à rouvrir le
bouton. La règle qui compte vit donc sur le serveur, dans
`src/lib/delais-message.mjs`, et elle se calcule avec l'heure du serveur.

> **Leçon.** Un contrôle fait sur l'appareil est une **politesse** : il évite
> de proposer un geste voué à l'échec. Seul le contrôle fait par le serveur
> est une **règle**.

### Quatre portes, un seul fichier

Chaque geste a deux chemins : le WebSocket et l'API REST. Cela fait quatre
portes :

| | WebSocket | REST |
|---|---|---|
| Modifier | `edit_message` | `PATCH …/messages/:id` |
| Supprimer pour tous | `delete_message` | `DELETE …/messages/:id?scope=everyone` |

Les quatre appellent les **mêmes** fonctions (`refusDelaiModification`,
`refusDelaiSuppression`). Recopier la règle quatre fois, c'est accepter qu'un
jour l'une des quatre diverge.

### La marge de deux minutes

Le serveur accepte jusqu'à 2 h **et 2 minutes**. Celui qui valide sa
modification à 1 h 59 ne doit pas se la voir refuser parce que la requête a
traversé un réseau lent, ou parce que son horloge retarde un peu sur la
nôtre.

Les clients, eux, ferment à 2 h pile. La marge ne profite donc qu'à un geste
**commencé à temps**.

## 2. Pourquoi l'ordre du chapitre 29 paie ici

Au chapitre 29, la modification d'un message chiffré suit un ordre précis :

1. **d'abord la date** (`PATCH { chiffre: true }`) ;
2. **ensuite les enveloppes** avec `modifie: true`.

On l'avait choisi pour que la ligne dise déjà « modifié » quand le
destinataire relève. Les délais lui donnent une seconde raison :

> Si le délai est dépassé, le serveur refuse le `PATCH`, et **aucune
> enveloppe n'est partie**.

Dans l'ordre inverse, les enveloppes seraient arrivées chez le destinataire,
avec le nouveau texte, **avant** que le serveur ne refuse. Le correspondant
aurait lu une modification que la règle interdisait. L'ordre ne protège pas
seulement l'affichage : il protège la règle.

Les deux clients font revenir l'ancien texte à l'écran quand le serveur
refuse (codes `DELAI_MODIFICATION_DEPASSE` et `DELAI_SUPPRESSION_DEPASSE`).

## 3. Le web modifie aussi

Le web utilise désormais le même protocole que le téléphone
(`modifierChiffre`, dans `e2ee-fil.ts`). Deux détails méritent d'être notés.

### Une modification ne redate pas le message

À la réception, `cacheModificationRecue` **remplace le texte** déjà rangé,
mais garde la **date d'envoi** d'origine. Sans cette précaution, le message
modifié remonterait en bas du fil, comme s'il venait d'arriver.

Si l'appareil ne connaissait pas encore ce message (enveloppe d'origine
jamais reçue ici), la modification est rangée comme un message ordinaire :
c'est son texte actuel.

### Mes autres appareils aussi

La modification part aussi vers les **autres appareils du même compte**,
comme un envoi. Le téléphone le fait déjà, par la même fonction que l'envoi
(`_enveloppesPour`). Sans cette copie, ton navigateur garderait l'ancien
texte d'un message que tu as modifié depuis ton téléphone.

## 4. Le partage : ce qui sort, ce qui entre

### Vers une autre application : le clair sort

« Partager » envoie le message à WhatsApp, Gmail ou une autre application.
Pour un message chiffré, l'appareil **déchiffre** le fichier et le donne en
clair à l'autre application.

C'est voulu, et il faut le dire franchement : c'est **l'utilisateur** qui
choisit de faire sortir ce message du chiffrement de bout en bout. Le
chiffrement protège un message **sur le trajet** et **chez le serveur**. Il ne
peut pas empêcher le destinataire légitime de le montrer à quelqu'un d'autre :
une capture d'écran ferait la même chose.

### Depuis une autre application : le clair entre, et se chiffre

Dans l'autre sens, un fichier partagé **vers** Alanya (depuis la Galerie, les
Fichiers…) arrive en clair, puisqu'il vient d'une autre application. Il suit
ensuite **exactement** le chemin d'un fichier choisi dans Alanya : plafond de
taille, compression, aperçu, légende, et **chiffrement** si la conversation
est chiffrée.

| Plateforme | Comment Alanya reçoit un partage |
|---|---|
| Android | filtres `SEND` du manifeste, greffon `share_handler` |
| Web installé | `share_target` du manifeste, rangé par le service worker |

### Les contacts en haut de la feuille de partage

Sur Android, chaque conversation où l'on écrit est publiée comme
**raccourci de partage**. Elle apparaît en tête de la feuille de partage du
système. Le raccourci ne contient que l'identifiant de la conversation et son
nom : **aucun contenu de message**.

## 5. Ce qui a été prouvé, et ce qui reste

- Serveur : 12 contrôles intégrés (`node src/lib/delais-message.mjs`) — bornes,
  marge, dates en texte, date illisible, horloge en avance.
- Mobile : `test/delais_message_test.dart`, parité des neuf langues.
- Web : bancs Chrome (menus selon l'âge du message, modifier, partager,
  partage reçu de bout en bout).
- **Pas encore fait** : un échange réel entre deux téléphones.

## 6. À retenir

- Une règle de temps se calcule sur **l'horloge du serveur**. Celle de
  l'appareil se règle à la main.
- Une même règle à plusieurs portes : **un seul fichier**, importé partout.
- Dater d'abord, envoyer ensuite : si la règle refuse, **rien n'est parti**.
- Une modification **remplace** un texte, elle ne **redate** pas un message.
- Partager vers une autre application fait sortir le message du chiffrement :
  c'est le choix de l'utilisateur, et le cours doit le dire.
