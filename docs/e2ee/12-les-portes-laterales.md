# Chapitre 12 — Les portes latérales

> **Où nous en sommes.** Depuis le 22/09, un fil chiffré refuse le texte en
> clair **à l'envoi**. C'était la porte principale. Ce chapitre fait le tour du
> bâtiment : combien d'autres gestes écrivent du texte dans un fil ?
>
> Deux, et une troisième porte qui n'a rien à voir avec le chiffrement.
>
> Branche `feat/e2ee` (backend `609cdda`, web `c71e286`) et
> `feat/chip-appel-callstyle` (mobile `3430bd4`).

---

## 1. La question qu'on ne s'était pas posée

La garde de l'envoi dit : *« dans un fil chiffré, pas de `content` »*. Elle est
juste. Mais elle est posée **sur un chemin**, pas **sur la donnée**. La vraie
question était :

> 🔴 **Qui, dans tout le serveur, écrit dans `message.content` ?**

`grep` répond en dix secondes :

```
ws-server.mjs              handleSend          ← gardé
ws-server.mjs              handleEditMessage   ← NON
ws-server.mjs              handleForwardMessage← NON
.../messages/[messageId]   PATCH               ← NON
.../messages/forward       POST                ← NON
```

Quatre portes ouvertes à côté de celle qu'on surveillait.

---

## 2. Modifier : le clair par la fenêtre

Le mobile proposait « Modifier » sur toute bulle de texte à soi. Dans un fil
chiffré, le texte modifié partait par `edit_message`, **en clair** :

- écrit dans `message.content` ;
- recopié dans `conversation.lastMessage` (l'aperçu de la liste) ;
- diffusé à chaque participant par le temps réel.

Tout ce que le chiffrement promettait d'éviter, en un geste.

**Le correctif est double**, et les deux moitiés comptent :

| où | quoi | pourquoi |
|---|---|---|
| serveur | refus `CONVERSATION_CHIFFREE` | un client modifié ne doit pas pouvoir passer |
| mobile | le menu ne propose plus « Modifier » | l'écran affiche la modification AVANT la réponse du serveur |

> ⚠️ **Un refus serveur seul laisse l'écran mentir.** Le mobile applique la
> modification localement tout de suite. Si le serveur refuse en silence,
> l'auteur voit son texte modifié… que personne d'autre ne voit. D'où aussi
> l'avis d'erreur renvoyé à l'auteur.

---

## 3. Transférer : deux fautes opposées

Le transfert recopie `original.content` vers chaque cible.

**Depuis un fil chiffré**, `content` est vide — le texte vit dans les
enveloppes. Le destinataire recevait une **bulle vide**.

**Vers un fil chiffré**, un texte en clair y entrait sans être chiffré.

Les deux se règlent par une seule règle, écrite **une fois**, dans
`src/lib/e2ee-clair.mjs` :

```js
if (sourceChiffree && type === "TEXT" && !aDuTexte) return SOURCE_CHIFFREE;
if (cibleChiffree && aDuTexte)                      return CONVERSATION_CHIFFREE;
```

⚠️ **Pourquoi un fichier `.mjs` sans import ?** Le WebSocket (`ws-server.mjs`)
et les routes Next doivent appliquer la même règle. Écrite deux fois, elle
divergerait — c'est la leçon des trois oublis du répondeur. Et sans import,
elle s'exécute seule : on l'a vérifiée contre 11 cas choisis avant de la
brancher.

⚠️ **Le média sans légende passe.** Les pièces jointes ne sont pas chiffrées
(chantier remis), et l'envoi les accepte déjà. Refuser ici ce que l'envoi
accepte rendrait la règle incohérente, et donc suspecte.

---

## 4. La troisième porte : le message d'un autre

En relisant la route REST du transfert pour y poser la garde, on lit ceci :

```ts
await assertParticipant(convId, userId);        // membre du fil de l'ADRESSE
const original = await prisma.message.findUnique({
  where: { id: messageId },                     // … message cherché PARTOUT
});
```

L'appartenance est vérifiée pour le fil **de l'adresse**. Le message, lui, est
cherché **dans toute la base**. Bob, membre d'un fil quelconque, pouvait donc
recopier chez lui un message d'une conversation Alice–Carole, et le lire.

Il lui suffisait d'en connaître l'identifiant. Et un UUID de message n'est pas
un secret : il circule dans les notifications, les réponses citées, les
journaux.

> 🔴 **Ce n'est pas un défaut de chiffrement, et c'est pour cela qu'il est
> grave : il touche TOUS les messages**, chiffrés ou non. Le banc l'a prouvé :
> `HTTP 201 — Bob a copié un message d'une conversation où il n'est pas`.

**Le correctif** : le message doit appartenir au fil de l'adresse, sinon
**404** — et non 403, qui confirmerait que ce message existe.

> ⚠️ **Le WebSocket faisait ce contrôle, le REST non.** Deux chemins pour le
> même geste, et un seul est gardé : c'est exactement la situation du §1. Un
> « repli REST » est un chemin à part entière, pas une copie de secours qu'on
> relit moins.

---

## 5. Le banc, et ce qu'il exige

`scripts/e2ee-clair-banc.mjs` joue chaque geste en REST **et** en WebSocket,
et chaque refus a son **témoin** : le même geste sur un fil ordinaire doit
passer.

```
avant correctif : 11 ✗ (fuites)   3 ✓ (témoins)
après correctif : 14 ✓
```

> ⚠️ **Sans témoins, ce banc ne prouverait rien.** Une garde qui refuse TOUT
> passerait les onze refus — et casserait la messagerie pour tout le monde.

---

## 6. Une difficulté d'environnement, notée pour la suite

Après avoir aligné la branche sur la production, la base locale n'avait pas
les dernières migrations (colonne `media.espace`). Une fois le client Prisma
régénéré, **aucun message ne pouvait plus y être créé** — et PostgreSQL,
configuré en français, faisait dire à Prisma que la colonne manquante
s'appelait… « colonne ».

> ⚠️ Un message d'erreur localisé peut être mal relu par l'outil qui le
> transmet. Le nom réel se retrouve dans le diff du schéma, pas dans l'erreur.

Le banc avait tourné **vert avant** cette régénération, sur une base et un
client cohérents : le correctif serveur est prouvé. La vérification dans le
navigateur (web) attend que la base locale soit remise à niveau.

---

## 7. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « L'envoi est gardé, donc le fil l'est » | La garde est sur un **chemin**, la fuite passe par un **autre** |
| « Le serveur refuse, c'est suffisant » | L'écran a déjà affiché la modification |
| « Le repli REST fait comme le WebSocket » | Il avait **oublié** un contrôle d'appartenance |
| « Un UUID ne se devine pas » | Il n'a pas besoin d'être deviné : il **circule** |

> 🔴 **Gardez la donnée, pas la porte.** Cherchez tout ce qui écrit dans la
> colonne à protéger, pas seulement le chemin par lequel vous l'avez vue
> s'écrire.
