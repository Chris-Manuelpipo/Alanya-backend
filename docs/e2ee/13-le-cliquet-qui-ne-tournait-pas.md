# Chapitre 13 — Le cliquet qui ne tournait pas

> **Où nous en sommes.** Les messages arrivent, se rangent, ne fuient plus.
> Reste une question que personne n'avait posée : **le Double Ratchet
> sert-il vraiment ?** Réponse mesurée : sur le web, jamais.
>
> Branches `feat/e2ee` (backend `dbd5e4f`, web `6de8890`) et
> `feat/chip-appel-callstyle` (mobile `a435380`).

---

## 1. Rappel : ce qu'on attend d'une session

X3DH est la **poignée de main** : coûteuse, elle consomme une pré-clé unique
du destinataire. Elle ne devrait avoir lieu qu'**une fois par couple
d'appareils**. Ensuite, le Double Ratchet fait tourner les clés à chaque
message, sans rien demander au serveur.

```
  1er message  : X3DH  → session         (1 pré-clé consommée)
  messages 2…n : cliquet, sur la session (0 pré-clé)
```

---

## 2. Ce que faisait le web

```ts
const devices = await ouvrirSessions(destinataire)   // à CHAQUE envoi
  // → GET /api/e2ee/cles/<destinataire>   (consomme 1 pré-clé / appareil)
  // → processPreKey(paquet)               (REMPLACE la session)
```

Et juste au-dessus, ce commentaire :

> *« la bibliothèque ne refait pas le travail si la session existe déjà »*

On a ouvert la bibliothèque :

```js
record.archiveCurrentState();     // sans condition
record.updateSessionState(session);
```

> 🔴 **Le commentaire était faux, et il protégeait l'erreur.** Qui le lisait
> n'avait aucune raison d'aller voir. C'est le motif ⑤ du registre, une fois
> de plus : le texte qui affirme plus que le code.

**Mesuré** (banc multifil ⑧) : trois messages d'Alice → **trois** pré-clés de
Bob consommées, trois enveloppes de type 3.

---

## 3. Pourquoi ça « marchait » quand même

Les messages arrivaient. Parce que la bibliothèque **archive** l'ancienne
session au lieu de la jeter (40 gardées), et que le destinataire essaie toutes
ses sessions au déchiffrement. Le défaut ne faisait donc rien perdre : il
**usait** le stock de pré-clés du correspondant et vidait le cliquet de son
sens.

> ⚠️ **« Ça marche » n'est pas une propriété de sécurité.** Un protocole peut
> livrer chaque message et ne tenir aucune de ses promesses.

---

## 4. Le mobile avait un demi-correctif

Le mobile ne refaisait plus la session (correctif du 27/09)… mais demandait
**toujours** le paquet pour savoir quels appareils viser. Or demander le
paquet, c'est consommer. Même usure, par une autre porte.

---

## 5. La correction : deux questions, deux réponses

Le client posait une seule question — « donne-moi de quoi écrire à Bob » — qui
en mélangeait deux :

| question | route | coût |
|---|---|---|
| quels appareils Bob a-t-il ? | `GET …/cles/<bob>?liste=1` | **rien** |
| le paquet de CES appareils | `GET …/cles/<bob>?deviceIds=…` | une pré-clé chacun |

Le client ne pose la seconde que pour les appareils **sans session**, ou dont
la **clé d'identité a changé**.

### Le cas qu'on aurait raté : l'appareil réinstallé

Bob réinstalle : même numéro d'appareil, identité neuve. Sa session d'avant ne
vaut plus rien. Un client qui se contente de « ai-je une session ? » répond oui,
chiffre sur l'ancienne, et Bob ne lit rien.

D'où la clé d'identité **dans la liste** : elle est publique, et elle permet de
voir le changement sans rien consommer. Le test mobile ④ le prouve — rouge sur
l'ancien code, vert sur le nouveau.

### Ne pas casser les APK déjà installés

Sans paramètre, la route se comporte comme avant. Et un client neuf face à un
serveur ancien retombe sur l'ancien appel. **Chaque moitié peut être déployée
avant l'autre.**

---

## 6. Une erreur de ma part, dans le banc

J'avais écrit : *« trois messages de plus partent en type 1 »*. Le banc a
échoué — avec le correctif.

Le protocole : tant que l'**initiateur** n'a reçu aucune réponse, il ne sait
pas si l'amorce X3DH est arrivée. La bibliothèque garde donc `pendingPreKey`,
et chaque message reste de **type 3** — même session, même pré-clé, **rien de
consommé**. Il passe en type 1 dès la première réponse.

> ⚠️ **Quand un banc échoue sur un code corrigé, vérifiez l'attendu avant le
> code.** Ici l'attendu était faux ; le contrôle juste est « après une réponse
> de Bob, Alice écrit en type 1 ».

---

## 7. Les numéros de pré-clés

Ils étaient tirés au sort entre 1 et 100 000, par lots de 50 consécutifs. Deux
lots peuvent se chevaucher :

```
  lot 1 : 41 200 … 41 249   (publié, en partie encore au serveur)
  lot 2 : 41 230 … 41 279   (41 230 à 41 249 ÉCRASÉS dans le coffre)
```

Le serveur, lui, écarte les doublons (`skipDuplicates`) et garde **l'ancienne**
clé publique. Le premier correspondant qui la reçoit ouvre une session que
personne ne peut déchiffrer. Rare, silencieux, définitif.

**Correctif** : un compteur (`reserverIdentifiants`), qui démarre au-dessus du
plus grand numéro déjà rangé — une installation existante a des numéros au
hasard qu'il ne faut pas heurter.

⚠️ **Ce banc prouve la propriété, pas la panne.** Un chevauchement au hasard
est trop rare pour se provoquer à coup sûr. On vérifie ce qui l'exclut : deux
publications ajoutent exactement 100 numéros, tous neufs et croissants.

---

## 8. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « La bibliothèque ne refait pas une session existante » | Elle la **remplace**, sans condition |
| « Les messages arrivent, donc le protocole marche » | Le cliquet ne tournait **jamais** |
| « Demander le paquet, c'est lire » | C'est **consommer** |
| « Une session existe, donc elle est bonne » | Pas si l'appareil a été **réinstallé** |
| « Un tirage sur 100 000 ne se heurte pas » | Par lots de 50, **si** — et en silence |

> 🔴 **Une lecture qui a un effet de bord n'est pas une lecture.** Séparez la
> question « qu'y a-t-il ? » de l'action « donne-le-moi ».
