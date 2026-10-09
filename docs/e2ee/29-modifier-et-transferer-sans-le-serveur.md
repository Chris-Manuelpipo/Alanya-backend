# Chapitre 29 — Modifier et transférer sans le serveur

> **Où nous en sommes.** 07/10/2026. Le chapitre 28 a appris aux fils chiffrés
> à répondre et à envoyer un contact. Deux autres gestes y restaient
> impossibles : **modifier** un message et le **transférer**. Ils ont la même
> cause, et la même solution : l'appareil fait ce que le serveur ne peut pas
> faire.
>
> Serveur `7d9a8be`, mobile `47a03ed` (modifier) et `ea7cc35` (transférer),
> web `647126a` (transférer), puis `98db89c` (modifier, le 07/10 au soir —
> voir le chapitre 30).

---

## 1. Le symptôme

Le user, le 07/10 :

> « Modifier le message ne donne plus. »
> « Transférer le message de tout type ne donne plus. »

Ces deux gestes fonctionnaient avant l'activation du chiffrement. Depuis que
la plupart des conversations sont chiffrées, ils ne donnaient plus rien.

## 2. La cause commune : le serveur travaille sur le contenu

Voici ce que faisaient ces deux gestes, côté serveur :

| Geste | Ce que faisait le serveur |
|---|---|
| Modifier | Il **remplaçait** `content` par le nouveau texte |
| Transférer | Il **recopiait** la ligne du message dans un autre fil |

Les deux supposent que le serveur **a** le contenu. Dans un fil chiffré, il
ne l'a pas. Le code le savait et refusait d'avance :

```js
// e2ee-clair.mjs
// Modifier un message chiffré demanderait de rechiffrer — un chantier à part.
export function refusModification({ filChiffre }) {
  return filChiffre ? CONVERSATION_CHIFFREE : null;
}
```

Le refus était juste. Mais, comme pour le contact au chapitre 28, **aucun
autre chemin n'existait**. L'écran masquait donc « Modifier », et écartait les
fils chiffrés de la liste de transfert.

> **Leçon.** Chaque fois qu'on refuse un geste au serveur pour protéger le
> contenu, il faut se demander : **qui d'autre a ce contenu ?** Dans un
> système chiffré de bout en bout, la réponse est toujours la même : les
> appareils.

## 3. Modifier : un second message, pour le même identifiant

### L'idée

Modifier un message chiffré, c'est envoyer un **nouveau texte** pour un
**message existant**. On dispose déjà de tout ce qu'il faut :

- les **enveloppes** savent transporter un texte (chapitres 1 à 22) ;
- une enveloppe est **rattachée à un message** par son identifiant ;
- le serveur accepte un **second dépôt** d'enveloppes pour le même message.

Il manque seulement une information pour le destinataire : **ce texte
remplace l'ancien**. D'où un nouveau champ de la charge v2 : `modifie: true`.

### Pourquoi ce drapeau est indispensable

Sans lui, la relève suit sa règle la plus importante :

> **Un texte connu n'est jamais remplacé.**

Cette règle protège contre un serveur qui tenterait de réécrire un message
déjà affiché. Le drapeau `modifie` est **dans le chiffré** : seul l'expéditeur
réel peut le poser, et seulement pour son propre message, puisque la relève
vérifie que l'expéditeur de l'enveloppe est l'auteur de la ligne.

### Le rôle du serveur

Le serveur ne fait plus qu'une chose : **dater** la modification.

```
PATCH /api/conversations/:id/messages/:messageId   { "chiffre": true }
```

Il vérifie que la demande vient de l'expéditeur, que le message est un texte
non supprimé, que le fil est chiffré, et que la ligne n'a **pas** de contenu.
Il pose alors `editedAt`, ce qui permet d'afficher « modifié » partout.

⚠️ Un ancien message écrit **en clair**, avant l'activation, reste non
modifiable. Le modifier exigerait d'effacer un clair que d'autres ont déjà
reçu.

### L'ordre compte

1. **D'abord la date** (PATCH) ;
2. **ensuite les enveloppes**.

Le dépôt déclenche la sonnette `e2ee_arrivee`, et le destinataire relève
aussitôt. À ce moment-là, la ligne doit déjà porter sa date de modification.

## 4. Transférer : renvoyer, pas recopier

### L'idée

Le serveur ne peut pas recopier ce qu'il ne lit pas. Mais l'appareil a le
contenu **en clair** : le texte déchiffré dans son cache, le fichier déchiffré
dans son cache de médias. Il peut donc le **renvoyer** comme un message neuf.

| Source | Cible | Qui transfère |
|---|---|---|
| ordinaire | ordinaire | le serveur (recopie, comme avant) |
| chiffrée | ordinaire | l'appareil (renvoie en clair) |
| ordinaire | chiffrée | l'appareil (renvoie chiffré) |
| chiffrée | chiffrée | l'appareil (renvoie chiffré) |

### Un média change de clé

C'est le point de sécurité du chapitre. Un média chiffré transféré vers un
autre fil est **rechiffré avec une nouvelle clé**, et téléversé comme un
nouveau fichier.

Pourquoi ne pas réutiliser la clé d'origine, ce qui éviterait de téléverser
à nouveau ?

- quiconque reçoit la copie aurait la clé de l'**original** ;
- le serveur verrait le **même fichier** dans deux fils, et pourrait les lier.

WhatsApp procède de la même façon.

### Un fichier lu une seule fois

Transférer vers cinq fils chiffrés ne déchiffre pas cinq fois le fichier : il
est lu une fois, puis rechiffré pour chaque cible.

## 5. Ce qui a été prouvé, et ce qui reste

- Mobile : tests du drapeau `modifie` (il voyage, il remplace, sans lui rien
  n'est remplacé), de la règle « serveur ou appareil », du correspondant ;
  suite complète : 359 tests.
- Web : contrôle des types, construction.
- Serveur : `tsc`.
- **Pas encore fait** : un échange réel entre deux appareils.
- ~~Le **web** n'a pas d'interface pour modifier un message.~~ **Corrigé le
  07/10 au soir** (`98db89c`) : le web modifie avec le même protocole. Voir
  le chapitre 30.

## 6. À retenir

- Quand le serveur ne peut pas faire un geste parce qu'il n'a pas le contenu,
  **l'appareil le fait**.
- Une modification chiffrée, c'est un **nouveau texte pour le même
  identifiant**, avec un drapeau **dans le chiffré** qui autorise le
  remplacement.
- Un transfert chiffré, c'est un **renvoi**, jamais une copie.
- Un média change de **clé** à chaque fil.
