# Chapitre 20 — Les portes que le chiffrement ne ferme pas

> **Où nous en sommes.** 28/09/2026, nuit. Lot B de la campagne : les failles
> du **serveur**. Aucune ne touche à la cryptographie. Le chiffrement
> protège le *contenu* ; il ne dit rien de *qui a le droit de faire quoi*. Ces
> contrôles-là restent le travail du serveur, et chacun manquait quelque part.
>
> Backend : ce chapitre et les commits du lot B.

---

## 1. Citer, c'est lire

Une réponse porte un `replyToId` : l'identifiant du message cité. À la lecture,
le serveur va chercher ce message et renvoie un aperçu (son texte, son auteur).

Deux trous, qui se complètent :

- **à l'écriture**, `replyToId` n'était jamais vérifié ;
- **à la lecture**, la citation se résolvait par le seul identifiant.

Bob, dans son propre fil, envoie une réponse dont le `replyToId` désigne un
message d'Alice à Carole. Le serveur lui rend le texte cité. **Bob lit une
conversation dont il n'est pas membre.**

C'est exactement le défaut H-3 (transférer un message étranger), par une autre
porte. Le correctif est le même, posé **aux deux bouts** :

| où | garde |
|---|---|
| `creerMessage` (REST, API v1, messagerie vocale) | le message cité doit être dans ce fil, sinon `404 REPLY_NOT_FOUND` |
| `handleSend` (WebSocket) | la même, car ce chemin ne passe pas par `creerMessage` |
| lecture REST et WebSocket | la citation se cherche par identifiant **et** fil |

> ⚠️ **Pourquoi garder aussi la lecture ?** Des citations étrangères ont pu
> s'écrire avant le correctif. Fermer l'écriture sans fermer la lecture
> laisserait ces lignes-là fuir pour toujours.

> 🔴 **Le chiffrement ne protège pas ici.** Dans un fil chiffré, `content` est
> vide : la fuite porte sur les fils ordinaires et sur l'historique d'avant
> l'activation. Mais le mécanisme est le même, et c'est lui qu'il fallait
> fermer.

**Erreur rencontrée** : le premier témoin du banc attendait la citation dans la
réponse à la création. Elle n'y est pas : on la voit en **relisant le fil**. Le
témoin échouait sur un attendu faux, pas sur le code. *Vérifier l'attendu autant
que le code* (déjà écrit au chapitre 9, et toujours vrai).

---

## 2. La sonnette avait sa propre porte

Un message chiffré s'écrit en deux temps : la ligne du fil, puis les
**enveloppes**, déposées par `POST /api/e2ee/enveloppes`. C'est ce dépôt qui
**sonne** (`e2ee_arrivee`) et **notifie** le destinataire (chapitre 3).

Il ne vérifiait qu'une chose : l'appartenance à la conversation.

| règle | message ordinaire | dépôt d'enveloppes (avant) |
|---|---|---|
| blocage | ✅ refusé | ❌ accepté, sonne, notifie |
| sourdine | ✅ pas de notification | ❌ notification |
| fil chiffré | — | ❌ accepté dans un fil ordinaire |
| sans ligne de message | — | ❌ sonne et notifie quand même |

La conséquence la plus concrète : **une personne bloquée pouvait faire vibrer,
en boucle, le téléphone de celle qui l'avait bloquée**, avec son nom affiché.

Et dans un fil **non** chiffré, une enveloppe rattachée à un message en clair
faisait marquer ce message `chiffre: true` à la lecture : **un cadenas affiché
sur un texte que le serveur lit.** Le pire mensonge qu'une interface de
chiffrement puisse faire.

Le correctif aligne le dépôt sur les autres chemins : fil chiffré exigé,
blocage refusé dans les deux sens, sourdine respectée, et aucune sonnette sans
ligne de message.

> ⚠️ **La sourdine n'est prouvée que par lecture** : l'envoi push est inerte en
> local, on ne peut pas compter les notifications. C'est dit dans le banc.

> ⚠️ **Avant de rendre `messageId` décisif, on a vérifié que les deux clients
> l'envoient toujours** (web `e2ee-fil.ts`, mobile `e2ee_fil.dart`). Sans cette
> lecture, la garde ④ aurait privé les vrais messages de leur sonnette.

---

## 3. « Supprimer pour tous », sauf le chiffré

Supprimer pour tous, côté serveur, c'était : `deletedAt = maintenant`,
`content = null`. Pour un message chiffré, `content` est **déjà** nul : l'effacer
ne supprime rien. Ses enveloppes, elles, restaient servies.

Un destinataire hors ligne au moment de la suppression relevait donc, plus tard,
un message que l'auteur avait supprimé — et le déchiffrait.

Le correctif tient en une ligne par chemin (REST et WebSocket) : les enveloppes
du message partent avec lui.

> 🔴 **Même famille que le chapitre 19.** Là, la restauration *recréait* un
> message supprimé sur le téléphone ; ici, le serveur *continuait de le livrer*.
> Une suppression doit atteindre **toutes** les copies, et un message chiffré
> en a plus qu'on ne croit : la ligne, les enveloppes, l'archive, les caches.

---

## 4. Le stock qu'un inconnu pouvait vider

Chaque paquet servi par `GET /api/e2ee/cles/<compte>` **consomme** une pré-clé
unique du compte. Sans pré-clé unique, X3DH fonctionne encore, mais en sautant un
calcul Diffie-Hellman : la session y perd une protection.

La route n'exigeait qu'une conversation en commun. Or une conversation se crée
avec un simple numéro public. **N'importe qui pouvait vider le stock de
n'importe qui.**

> 🐛 **Le banc qui rassurait à tort.** L'étape ⑬ de `e2ee-banc.mjs` testait un
> inconnu *sans* conversation. Elle passait, et laissait croire la porte
> fermée. Un banc ne prouve que le scénario qu'il joue.

Pour **consommer**, il faut désormais :

1. un fil **chiffré** en commun — les clients n'ouvrent une session qu'en
   envoyant dans un fil chiffré, et l'activation lit les identités sans passer
   par cette route ;
2. aucun blocage entre les deux ;
3. un débit raisonnable : 20 demandes par heure et par paire.

La **liste** des appareils (`?liste=1`), qui ne consomme rien, garde la règle de
la conversation en commun, mais tombe elle aussi devant un blocage.

---

## 5. Une lecture qui faisait tomber le serveur

L'archive chiffrée se relit par pages de 2 000 blocs, et un bloc peut peser
512 Ko. Une seule page, c'était donc jusqu'à **1 Go** chargé et sérialisé en
mémoire : le processus Next tombait — pour tous les utilisateurs. Et rien ne
limitait le dépôt : un compte pouvait remplir le disque.

| | avant | après |
|---|---|---|
| taille d'une page | 2 000 blocs, sans limite d'octets | 2 000 blocs **et** 8 Mo |
| volume d'une archive | illimité | 256 Mo, puis `413 ARCHIVE_PLEINE` |

La lecture se fait maintenant en trois temps : les identifiants de la page, puis
leur **taille** seulement, puis le contenu des seuls blocs retenus. On ne charge
jamais ce qu'on ne rendra pas.

> ⚠️ **Un bloc passe toujours, même seul au-delà du plafond.** Une page vide
> accompagnée d'un curseur `suivant` ferait tourner le client en rond.

> ⚠️ **`suivant` est devenu exact.** Il était posé dès que la page était
> pleine, même s'il ne restait rien : un aller-retour de trop. On demande
> maintenant un bloc de plus pour savoir s'il en reste.

---

## 6. À retenir

1. **Le chiffrement protège le contenu, pas les droits.** Qui peut citer,
   sonner, consommer, lire l'archive : tout cela reste le travail du serveur.
2. **Une règle vaut pour toutes les portes, ou pour aucune.** Le blocage était
   appliqué au WebSocket et à `creerMessage` ; le dépôt d'enveloppes, troisième
   porte, l'ignorait.
3. **Fermer l'écriture ne ferme pas ce qui est déjà écrit.** D'où la garde à
   la lecture des citations.
4. **Un banc ne prouve que ce qu'il joue.** L'inconnu sans conversation n'était
   pas le bon attaquant.
5. **Borner en nombre ne borne pas en taille.** 2 000, c'est peu ; 2 000 fois
   512 Ko, non.
