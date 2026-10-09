# Chapitre 26 — Fermer la porte du clair

> **Où nous en sommes.** 03/10/2026. Les deux clients savent lire (chapitre 23)
> et envoyer (chapitres 24 et 25) un média chiffré. Ce chapitre couvre le
> **lot D**, celui de la **fermeture** :
>
> - le serveur refuse désormais un média en clair dans un fil chiffré ;
> - le texte passe à la charge v2, celle des médias.
>
> Serveur, web et mobile : un commit chacun.

---

## 1. La dernière porte ouverte

Depuis le 22/09, un fil chiffré refuse le **texte** en clair. Les pièces
jointes, elles, passaient : tant qu'aucun client ne savait chiffrer un fichier,
les refuser aurait rendu un fil chiffré muet en photos. C'était un choix
assumé, écrit en toutes lettres dans `ws-server.mjs` :

> « LES MEDIAS PASSENT ENCORE — ils ne sont pas chiffres (chantier remis). »

Conséquence concrète : une photo sans légende entrait **en clair** dans une
conversation dont l'écran annonçait « chiffrée de bout en bout ». Lisible par
le serveur, et par quiconque lit le stockage.

Les lots A à C ont appris aux deux clients à chiffrer leurs fichiers. La porte
peut donc se fermer.

## 2. Une règle, quatre portes

Un fichier peut entrer dans un fil par quatre chemins :

| Chemin | Où |
|---|---|
| Envoi temps réel | `ws-server.mjs`, `handleSend` |
| Envoi REST (dont le chemin chiffré) | `envoi.ts`, `creerMessage` |
| Transfert temps réel | `ws-server.mjs`, `forward_message` |
| Transfert REST | `forward/route.ts` |

La règle est écrite **une seule fois**, dans `src/lib/e2ee-clair.mjs` :

```js
export function refusMediaEnClair({ filChiffre, medias }) {
  if (!filChiffre) return null;
  return (medias ?? []).some((m) => m?.chiffre !== true) ? CONVERSATION_CHIFFREE : null;
}
```

Les quatre chemins l'appellent. C'est la leçon des trois oublis du répondeur :
une règle recopiée dans quatre fichiers finit toujours par manquer dans le
cinquième.

**Deux détails qui comptent.**

- **Le drapeau `chiffre` est lu en BASE**, tel que le téléversement l'a posé —
  jamais tel que le client le déclare dans son message. Un client qui
  affirmerait « ce fichier est chiffré » ne prouve rien.
- **Le code de refus est celui du texte, `CONVERSATION_CHIFFREE`.** Il dit
  « ce chemin ne peut pas écrire dans ce fil », et les clients le connaissent
  déjà. Un code nouveau, un ancien client ne le comprendrait pas : sa bulle
  tournerait sans fin.

**Le piège du chemin chiffré lui-même.** On pourrait croire le chemin REST
chiffré sûr par construction : il n'accepte que `chiffre: true`. Mais ce
drapeau dit « je n'apporte pas de texte » ; il ne dit **rien des fichiers**.
Sans la nouvelle garde, ce chemin pouvait rattacher une photo en clair à un
fil chiffré.

## 3. Ce qu'un refus ne peut pas empêcher

Envoyer un média se fait en deux temps : **téléverser** le fichier, **puis**
créer le message. Le serveur ne connaît le fil qu'au second temps.

Quand il refuse, le fichier en clair est donc **déjà sur le stockage**. Le
refus empêche qu'il entre dans le fil ; il ne peut pas empêcher qu'il ait été
envoyé.

Seul l'expéditeur peut l'éviter, en sachant **avant** de téléverser que le fil
est chiffré. D'où la même garde que pour le texte, ajoutée aux deux clients :

> **État du fil inconnu → on le demande au serveur avant d'envoyer.**

Le refus du serveur reste le filet ; la question préalable est la protection.

## 4. Le texte en charge v2

### Le trou

En v1, l'enveloppe d'un texte ne contenait que le texte. L'identifiant du
message voyageait **à côté**, en clair, posé par le serveur.

Le chapitre de la relève avait déjà fermé le gros du trou : un texte n'est
appliqué qu'à une ligne dont l'expéditeur et le fil correspondent. Restait
une manœuvre au serveur : **rattacher le texte de Bob à un AUTRE message de
Bob, dans le même fil**. Bob écrit « oui » à une question, « non » à une
autre ; le serveur échange les deux.

### La fermeture

La charge v2, créée pour les médias (chapitre 23), porte l'identifiant
**dans** le chiffré :

```
"\u0000A2" + {"v":2,"id":"<id du message>","texte":"…"}
```

À la lecture, `lireCharge` compare cet identifiant à celui de la ligne. S'ils
diffèrent, l'enveloppe est refusée. Le serveur ne peut plus déplacer un texte :
il ne peut pas réécrire ce qu'il ne peut pas lire.

### Ce que cela change sur le téléphone

Le mobile chiffrait le texte **avant** de créer la ligne du message. Or, pour
écrire la charge v2, il faut l'identifiant, donc la ligne. L'ordre s'inverse :

1. ouvrir les sessions (c'est là qu'un échec est probable : réseau, pré-clés) ;
2. créer la ligne ;
3. chiffrer la charge v2 ;
4. déposer les enveloppes.

C'était déjà l'ordre du web, et celui des médias (chapitre 25 l'annonçait).

### L'ordre de déploiement

Un lecteur trop ancien ne connaît pas le préfixe v2 : il afficherait la charge
brute. Les deux lecteurs le connaissent depuis le lot A (web en production,
APK du lot A). **On ne déploie donc le lot D qu'après la mise à jour des
téléphones.**

Les messages v1, eux, restent lisibles : les anciens messages, et ceux d'un
client pas encore à jour. Ils restent aussi exposés à la manœuvre décrite plus
haut. Refuser le v1 sera possible le jour où plus aucun client ne l'écrit.

## 5. Trois défauts trouvés en chemin

**1. Le transfert REST d'un média échouait toujours.** Le message était créé
avec `connect: [...]` posé à plat, au lieu de `media: { connect: [...] }`.
Prisma refusait : erreur 400 à chaque fois. Personne ne l'avait vu, parce
que les clients transfèrent par le WebSocket.

Trouvé par un **témoin** du banc : le même transfert vers un fil ordinaire
devait réussir, et il échouait.

**2. Le transfert REST recopiait un média chiffré.** Le WebSocket l'écartait
depuis le lot A, cette route non. Le destinataire aurait reçu un fichier
illisible, puisque le serveur n'a pas la clé. Il est maintenant refusé
(`SOURCE_CHIFFREE`).

**3. Un banc web était rouge depuis le 28/09.** `e2ee-web-test.ts` cherchait
le texte relevé avec `includes(attendu)` dans les valeurs rendues par la
relève. Or ces valeurs sont devenues des objets (`ClairRecu`) le 28/09 :
aucune chaîne ne pouvait plus y être trouvée. Le déchiffrement fonctionnait ;
c'est le banc qui ne savait plus regarder.

La leçon : un banc qu'on ne relance pas finit par mentir.

## 6. Ce qui a été prouvé, et ce qui reste

**Prouvé contre le vrai serveur local :**

- `e2ee-clair-banc.mjs`, section ⑤ : un média en clair refusé dans un fil
  chiffré, par l'envoi temps réel, l'envoi REST chiffré et les deux
  transferts. Chaque refus a son **témoin** : un fichier chiffré passe dans le
  fil chiffré, un fichier en clair dans un fil ordinaire ;
- les bancs web du texte et des médias, avec le texte en v2 ;
- la suite des tests mobiles.

**Ce qui reste.**

- **Transférer un média VERS un fil chiffré n'est plus possible.** Le serveur
  ne peut ni le faire en clair (c'est la fuite qu'on ferme) ni le chiffrer (il
  n'a pas de clé). Il faudra que l'**appareil** transfère : récupérer le
  fichier, le chiffrer, l'envoyer. C'est un chantier à part.
- La vérification sur un vrai téléphone.

## 7. Le vrai coupable du chargement sans fin

Après le déploiement, le téléphone affichait toujours ses photos chiffrées
floues, avec un chargement qui ne finissait pas. La grille avait pourtant été
corrigée (chapitre 25).

**Une piste séduisante, et fausse.** Le téléchargement du mobile n'avait ni
délai, ni en-tête `Authorization`, et mettait le jeton dans l'adresse. Le
soupçon : un jeton mal encodé, refusé, et un serveur qui ne répond plus.
Vérifié avant de corriger :

- un JWT est en base64url : il ne contient ni `+` ni `/`, rien à encoder ;
- le serveur répond en moins d'une seconde, en JSON (401 sans jeton, 400 avec
  un faux). Rien ne reste ouvert.

**Le test qui a parlé.** Un test contre un vrai petit serveur local, qui
répondait 401 tout de suite. La fonction d'ouverture levait bien son erreur,
passait bien par `finally`… et l'appelant n'était jamais prévenu.

**La cause, en une ligne :**

```dart
_ouvrir(d, baseUrl, token).whenComplete(() => _enCours.remove(d.id));
```

- la flèche `=>` RENVOIE ce que `remove` rend : la valeur retirée de la
  table, c'est-à-dire **ce Future-là** ;
- `whenComplete` **attend** tout Future que son rappel renvoie ;
- le Future s'attendait donc lui-même. Il ne finissait jamais, ni en succès ni
  en erreur — même quand le fichier était déjà dans le cache.

La correction tient en deux accolades : un corps qui ne renvoie rien.

```dart
_ouvrir(d, baseUrl, token).whenComplete(() {
  _enCours.remove(d.id);
});
```

**Pourquoi aucun banc ne l'a vu.** Le banc d'interopérabilité (web → mobile)
appelait directement la fonction de déchiffrement, sans passer par
`ouvrir`. Il prouvait que le mobile savait déchiffrer, pas que l'écran
recevait le résultat.

**Gardé quand même :** un délai d'inactivité de 30 s, deux nouvelles
tentatives et le jeton en en-tête, comme pour les autres médias. Ce n'était
pas la cause, mais une connexion muette aurait produit le même symptôme.

## 8. Le jeton lu trop tôt

Deux symptômes, une seule cause :

- « A envoie un média à B : impossible de télécharger, il faut rouvrir la
  conversation » ;
- « Médias partagés » vide, même pour les anciens médias en clair.

**La cause.** Les deux écrans lisaient le jeton d'accès **une fois**, au
début, puis chargeaient les messages. Un jeton d'accès vit 15 minutes. S'il
avait expiré, le chargement des messages le **rafraîchissait** dans le
stockage — mais l'écran gardait l'ancien, et chaque média partait avec un
jeton mort : 401. Rouvrir la conversation relisait le bon.

**La correction.**

- Un média chiffré demande son jeton **au moment** de le télécharger
  (`AuthedApi.jeton`) ; sur un 401, il le fait rafraîchir une fois, sous le
  même verrou que le reste de l'application, et réessaie.
- « Médias partagés » lit le jeton **après** les messages.

**Et deux défauts de plus dans « Médias partagés ».**

- **Une seule page lue** : les 50 derniers messages. Un média plus ancien
  n'apparaissait jamais. L'écran parcourt maintenant toutes les pages.
- **Les médias chiffrés étaient ignorés.** Leur clé n'est que sur le
  téléphone, dans le cache local : l'écran l'y lit et les affiche avec la
  même tuile que la grille, qui déchiffre la sienne.

## 9. La copie qu'on avait oubliée, et la galerie

**La fiche contact.** Sa bande d'aperçus restait vide, alors que « Médias
partagés » s'affichait. L'écran avait **sa propre copie** du chargement, avec
les trois défauts que l'autre venait de perdre (jeton lu trop tôt, une seule
page, médias chiffrés passés tels quels). On avait corrigé une copie, pas
l'autre.

La correction n'est pas une deuxième correction, c'est **un seul
chargement** (`medias_partages.dart`), utilisé par la fiche contact, par
« Médias partagés » et par la galerie.

**La galerie.** Elle écartait les médias chiffrés, et toucher l'un d'eux
ouvrait une page qui ne montrait que lui : on ne glissait plus d'un média à
l'autre. Un élément de galerie peut maintenant porter le **descripteur** d'un
média chiffré ; sa page le déchiffre (photo zoomable, vidéo lisible). Le
bouton « enregistrer » est masqué pour lui : le fichier du serveur serait
illisible.

**L'envoi.** La bulle d'un média chiffré en cours d'envoi n'était qu'un trait
qui défilait. Elle montre la vignette locale et le pourcentage du
téléversement, comme l'envoi ordinaire.

## 10. À retenir

- Une règle, un fichier, **tous** les chemins qui écrivent.
- Ce que le serveur vérifie se lit **en base**, jamais dans la parole du
  client.
- Un refus arrive après l'envoi : la vraie protection est chez l'expéditeur,
  **avant**.
- Ce qui doit rester attaché au contenu voyage **dans** le chiffré.
- Chaque refus a son témoin, et un banc se relance.
- Une hypothèse se vérifie avant de se corriger, même quand elle est
  plausible.
- Un banc doit passer par le chemin de l'écran, pas à côté.
- Un jeton se lit au moment de s'en servir, jamais une fois pour toutes.
- Corriger une copie laisse l'autre fautive : on supprime la copie.
- `=>` renvoie toujours quelque chose : dans un rappel, ce « quelque chose »
  peut être attendu.
