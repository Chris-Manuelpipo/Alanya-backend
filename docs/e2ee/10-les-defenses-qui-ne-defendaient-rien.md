# Chapitre 10 — Les défenses qui ne défendaient rien

> **Où nous en sommes.** Tout le chiffrement est écrit, des deux côtés, et il
> fonctionne. C'est justement le bon moment pour le relire à neuf — non pas
> « est-ce que ça marche », mais **« qu'est-ce qui protège vraiment ? »**
>
> Quatre défauts, et le pire n'était pas dans la liste de départ.
>
> Branches `feat/e2ee` (web) et `feat/chip-appel-callstyle` (mobile).

---

## 0. Celui qu'on n'avait pas vu venir

En corrigeant le deuxième point de la liste, on tombe sur ceci :

```dart
await api('POST', '/api/e2ee/cles', { … });
```

Et dans le backend :

```ts
export const GET    = withAuth(…)
export const PUT    = withAuth(…)
export const DELETE = withAuth(…)
```

Pas de `POST`.

> 🔴 **Le mobile n'avait jamais publié une seule clé.** Le serveur répondait
> 405, et personne au monde ne pouvait lui écrire — en ligne ou non.

Et ce n'était pas la seule erreur du même appel : le serveur lit `prekeys` et
`id`, le mobile envoyait `prekeysUniques` et `prekeyId`.

**Trois erreurs sur une seule requête.** Il faut comprendre pourquoi aucune ne
s'est vue.

### Trois filets, et le défaut passe entre les trois

| Filet | Pourquoi il ne voit rien |
|---|---|
| `dart analyze` | Une route est une **chaîne**. Rien à analyser. |
| Le banc d'interopérabilité | Il branche une **fausse fonction réseau** : il éprouve le protocole Signal, jamais le contrat HTTP. |
| `demarrer()` | Il rattrape **toute** exception, pour ne pas bloquer le lancement. L'échec était donc muet. |

Chacun de ces trois choix est bon pris isolément. Leur **combinaison** laisse
passer une panne totale sans le moindre signal.

> ⚠️ **Un banc qui remplace le réseau ne prouve rien sur le réseau.** Il prouve
> ce qu'il exécute, pas ce qu'il simule. C'est vrai de tous les doubles de test,
> et c'est la raison pour laquelle il en faut d'un autre genre à côté.

### Le contrôle qui ferme la porte

`outils/contrat_routes.py` lit les appels `api('VERBE', '/chemin')` du mobile et
les confronte aux méthodes **réellement exportées** par la route correspondante
du backend.

Il tourne en quelques secondes, sans serveur ni base.

Éprouvé comme toujours : remis en `POST`, il refuse.

```
VERBE REFUSE    POST /api/e2ee/cles
                la route accepte : DELETE, GET, PUT
```

---

## 1. L'alerte qui s'évaporait

Le changement de clé d'identité est **le seul signal** capable de révéler une
interposition. Voici comment il était rangé :

```ts
const clesChangees = new Set<string>()   // web
```
```dart
final Set<String> correspondantsChanges = {};   // mobile
```

En mémoire. Le commentaire justifiait ce choix, et l'argument est bon :

> « Le ranger ferait réapparaître à chaque ouverture une alerte déjà vue — et
> une alerte qui se répète cesse d'être lue. »

C'est vrai. Mais regardez ce qui se passe juste avant :

```dart
await _ecrire(k, apres);            // la NOUVELLE clé est écrite
final change = avant != apres;      // et seulement ensuite on le remarque
```

> 🔴 Au moment où l'on détecte le changement, **la nouvelle clé est déjà
> rangée**. Plus rien ne pourra le redétecter. Jamais.

Application fermée avant d'avoir ouvert cette conversation — sur un téléphone,
vingt fois par jour — et l'avertissement est perdu **définitivement**.

> 🔴 **Une substitution de clé réussie pouvait donc passer totalement
> inaperçue.** Il suffisait d'un redémarrage.

### Les deux propriétés se tiennent ensemble

On croyait devoir choisir entre :

- une alerte qui **se répète** (et qu'on apprend à balayer) ;
- une alerte qui **se perd** (et qui ne protège de rien).

Il n'y avait pas à choisir. L'**accusé de lecture** donne les deux :

```
posée  →  persiste tant que personne ne l'a vue  →  vue  →  disparaît à jamais
```

Une clé dans le coffre, effacée sur un geste. Sept lignes.

### Un détail qui aurait tout annulé

Le web notait le changement à deux endroits, avec deux identifiants
**différents** : `compte` d'un côté, `compte.appareil` de l'autre. L'écran, lui,
n'interroge que le compte.

> ⚠️ La moitié des alertes étaient donc rangées sous une clé que **personne
> n'interroge jamais**. La normalisation vit maintenant *dans* la fonction, pas
> chez ses deux appelants — un appelant l'oubliait déjà.

---

## 2. Le stock qui ne se reconstituait pas

Le serveur réclame depuis le premier jour :

```json
{ "prekeysRestantes": 3, "reapproNecessaire": true, "seuil": 10 }
```

Le web écoute. Le mobile, non. Et à sa place, ce commentaire :

> « Le stock se réapprovisionnera quand il baissera, pas à chaque lancement. »

**Rien ne l'implémentait.**

> 🔴 **Un commentaire qui décrit une intention comme un fait est pire que pas de
> commentaire** : il fait passer la relecture suivante à côté. Celui-ci a tenu
> plusieurs semaines, et il était de ma main.

Les 50 pré-clés à usage unique s'épuisent au fil des nouveaux correspondants. Au
51ᵉ, plus personne ne peut ouvrir de conversation avec ce téléphone. **Panne
muette** : rien ne casse chez celui qui la subit, ce sont les *autres* qui
n'arrivent plus à lui écrire.

### Et le piège dans le piège

```dart
final uniques = generatePreKeys(0, lotPreKeys);   // toujours 0…49
```

Republier aurait produit **exactement les mêmes numéros**, que le serveur écarte
(`skipDuplicates`). Sans erreur, sans message.

> ⚠️ Le correctif « évident » — rappeler la publication — n'aurait donc rien
> réapprovisionné du tout. Les identifiants sont désormais tirés au sort, comme
> sur le web depuis toujours.

---

## 3. Une promesse fausse vaut moins qu'un silence

Dans une conversation chiffrée, les pièces jointes passent **en clair**. C'est
une décision assumée, le chiffrement des médias est remis à plus tard.

Le web l'affiche. Le mobile n'avait même pas la phrase.

> ⚠️ **Ce n'est pas un manque, c'est une promesse fausse.** Quelqu'un qui lit
> « chiffré de bout en bout » envoie sa photo en croyant qu'elle est protégée
> comme son texte. Reporter une fonctionnalité se décide ; le silence, lui, ne
> se décide pas — il trompe.

Et l'endroit compte : **sous la bannière**, là où l'on joint un fichier. Dans un
écran de réglages, personne ne la lirait au moment qui compte.

---

## 4. On n'exécute pas une dérivation dont un tiers choisit les paramètres

À la pose, c'est nous qui écrivons les réglages. À l'ouverture, on relisait ce
que le serveur voulait bien rendre :

```ts
deriverKek(secret, sel, serrure.algo, JSON.parse(serrure.parametres))
```

Soyons précis sur ce que cela vaut, parce qu'il serait facile d'en faire trop :

> ⚠️ **Ce n'est PAS une divulgation de clé.** Le paquet reste chiffré sous la
> vraie KEK ; de mauvais paramètres donnent une mauvaise clé, donc un échec
> d'authentification, et rien de plus.

Ce qu'on évite est ailleurs :

| | |
|---|---|
| **Déni de service** | `memoireKio: 4000000` réclame quatre gigaoctets à Argon2id. L'onglet tombe, le téléphone aussi. |
| **Déclassement à venir** | Le jour où un algorithme plus faible sera accepté pour relire d'anciennes serrures, le serveur pourra le **réclamer**. |

> 🔴 **On ne fait jamais tourner une fonction de dérivation dont un tiers
> choisit les paramètres.** La règle vaut même quand on ne voit pas d'attaque —
> c'est l'attaque qu'on ne voit pas qui la rend utile.

Et un type de serrure inconnu est refusé, pas deviné : « appliquer les réglages
les plus proches » *serait* le déclassement.

---

## 5. La leçon sur les bancs, qui vaut le chapitre à elle seule

Les trois vérifications du point ④ passaient au premier essai. Vert partout.

Elles passaient **pour la mauvaise raison**.

```js
await leve(() => ouvrirArchive(MDP, [affaiblie]))   // ← un tableau
```

`ouvrirArchive` prend **une** serrure, pas un tableau. Donc `serrure.sel` valait
`undefined`, et `atob(undefined)` levait. Mon banc constatait bien qu'« il y a eu
une exception » — mais pas celle qu'il croyait.

> 🔴 **Un banc qui passe pour la mauvaise raison est pire qu'un banc qui
> échoue** : il distribue de la confiance sans rien prouver, et on ne revient
> jamais dessus.

Le remède tient en une ligne, et il devrait précéder toute série de refus :

```js
verifie(
  "la serrure témoin s'ouvre AVANT qu'on y touche",
  (await ouvrirArchive(MDP, serrureMdp)) !== undefined,
  "sans cela, les refus qui suivent ne prouveraient rien",
)
```

**Prouvez d'abord que le cas normal passe.** Sans ce témoin, « tout est refusé »
et « le contrôle marche » se ressemblent trait pour trait.

### Le même principe, appliqué au banc de persistance

Pour éprouver que l'alerte survit à un rechargement, il ne suffisait pas de la
relire :

> ⚠️ `ouvrirCoffre()` met son ouverture **en cache**. Relire dans le même module
> ne relit rien — et l'ancien `Set` en mémoire aurait passé un banc écrit ainsi.

Le lanceur charge donc le module **trois fois**, avec un `?v=n` différent, sur la
même base IndexedDB. Trois modules neufs, un seul disque : c'est la seule façon
de reproduire un rechargement de page dans un processus.

Et on le vérifie par la négative : remis en mémoire, le banc **échoue**.

---

## 6. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « Le banc d'interopérabilité couvre l'envoi » | Il couvre le **protocole**, pas le **contrat HTTP** |
| « Ce commentaire décrit le code » | Il décrivait une **intention** jamais écrite |
| « Rattraper l'exception évite de bloquer » | Et **efface la seule trace** de la panne |
| « L'alerte en mémoire suffit pour la session » | La session **finit**, l'attaque reste |
| « Mes trois refus sont verts » | Ils l'étaient **pour une autre raison** |

Et la règle qui les traverse toutes :

> 🔴 **Une défense qu'on n'a jamais vue défendre n'est pas une défense.**
> Faites échouer votre contrôle exprès. S'il ne bronche pas, vous n'aviez rien.
