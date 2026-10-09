# Chapitre 8 — Deux clients, une seule langue

> **Où nous en sommes.** Le web chiffre, archive et restaure. Reste le mobile —
> et une question qui pouvait tout faire tomber : *est-ce que deux bibliothèques
> différentes parlent le même protocole ?*
>
> Ce chapitre raconte le ticket qu'on a fait passer **avant tous les autres**, et
> la politique de sécurité qui a failli désactiver le chiffrement.
>
> Lots 4 et 5.2. Branches `feat/e2ee`.

---

## 1. Le ticket qu'on fait passer en premier

Le mobile est en Flutter, donc en Dart. Le web utilise une bibliothèque
TypeScript. Deux implémentations différentes du même protocole.

La tentation est d'écrire l'application d'abord et de brancher le chiffrement
ensuite. Voici pourquoi c'est le mauvais ordre :

> 🔴 Si les deux bibliothèques ne produisent pas le même format sur le fil, ce
> n'est **pas un défaut à corriger** — c'est le choix de bibliothèque qui tombe,
> et avec lui tout le calendrier.

On le découvre en deux jours sur un fil de test, ou en trois semaines une fois
l'interface écrite. Le ticket **4.0** a donc été créé exprès pour passer devant
tout le reste.

### Ce qu'il fait

```
  ① le MOBILE publie son paquet de pré-clés        (Dart)
  ② le WEB ouvre une session dessus et chiffre      (TypeScript)
  ③ le MOBILE déchiffre, et répond                  (Dart)
  ④ le WEB déchiffre la réponse                     (TypeScript)
  ⑤ les deux calculent le code de sécurité
```

**Tout passe.** Les deux bibliothèques se comprennent.

### ⚠️ Sans construire d'APK

Point pratique qui change tout : le côté mobile du banc est du **Dart pur**, pas
du Flutter. Il tourne sur la machine de développement en quelques secondes.

> Ce qui est prouvé, c'est le **protocole**. Ce qui ne l'est pas, c'est
> l'application — interface, coffre matériel, réseau. Savoir distinguer les deux
> évite à la fois de trop promettre et de trop attendre.

---

## 2. L'encodage, ce détail qui n'en est pas un

Le banc vérifie une chose en apparence anecdotique :

```js
la clé d'identité fait 33 octets et commence par 0x05   ✓
```

33 octets pour une clé Curve25519 qui en fait 32. L'octet supplémentaire, `0x05`,
dit « ceci est une clé Curve25519 ».

**Si les deux bibliothèques divergeaient là-dessus**, tout échouerait — mais avec
un message parlant de « signature invalide ». On chercherait du côté de la
signature pendant des heures, alors que le problème serait un octet de préfixe.

> **Vérifier explicitement ce qui est implicite** fait gagner le temps qu'on
> aurait perdu à mal chercher.

---

## 3. Le code de sécurité, écrit deux fois exprès

La bibliothèque Dart **n'a pas de classe `Fingerprint`**. Il a donc fallu
réimplémenter l'algorithme de Signal à la main — les 5 200 itérations de SHA-512
du chapitre 6.

Il existe maintenant deux implémentations : une en TypeScript, une en Dart.

C'est normalement une mauvaise idée. Ici c'est **volontaire**, et le banc compare
leurs résultats :

```
  les deux codes sont identiques   ✓
  42226 29050 05067 60954 07307 70905 ...
```

Pourquoi c'est vital :

> ⚠️ Si les deux divergeaient, les utilisateurs compareraient des codes
> **différents pour les mêmes clés** et concluraient à une interposition qui
> n'existe pas. La confiance se perdrait **sans qu'un seul octet n'ait fuité**.

Un défaut de sécurité ne se mesure pas seulement aux données perdues. Détruire à
tort la confiance dans une protection qui marche en est un aussi.

Le banc vérifie également que le code **ne dépend pas de qui regarde** — les deux
moitiés sont triées, sinon Alice et Bob liraient des chaînes différentes.

---

## 4. La politique de sécurité qui désactivait le chiffrement

Passons au ticket 5.2. Le coffre chiffré empêche d'**emporter** les clés : elles
sont scellées par une clé non extractible.

Il n'empêche **pas** un script hostile de s'en **servir sur place** — de
déchiffrer les messages dans l'onglet et de les envoyer ailleurs.

La CSP est la seule défense contre cela. Elle dit d'où le code peut venir, et où
les données peuvent aller.

### 🐛 Premier défaut : WebAssembly bloqué

Le banc a signalé :

```
script-src → wasm-eval
```

Sans `'wasm-unsafe-eval'`, le navigateur refuse d'instancier **le moindre module
WebAssembly**. Or deux pièces essentielles en sont faites : **Argon2id** (la
serrure « mot de passe ») et **Curve25519** (tout le protocole Signal).

> 🔴 Une CSP qui casse le chiffrement qu'elle protège est le pire des deux
> mondes : on croit avoir durci, et on a **désactivé**.

⚠️ Et il faut la bonne directive : `'unsafe-eval'` autoriserait `eval()` sur du
JavaScript — exactement ce que la politique existe pour empêcher.
`'wasm-unsafe-eval'` n'ouvre que WebAssembly, livré avec l'application.

### 🐛 Second défaut : l'adresse du WebSocket

```
connect-src → wss://alanyavox.com/ws
```

La politique déduisait l'adresse du WebSocket de celle de l'API. Or
`VITE_WS_URL` est une variable **séparée**.

> ⚠️ Ce défaut aurait été **silencieux et grave** : l'application se charge, on
> se connecte, on lit ses messages — et plus rien n'arrive en temps réel. On
> aurait cherché du côté du serveur pendant des heures.

**Aucun des deux n'a été trouvé par raisonnement.** Les deux viennent du banc.

---

## 5. Tester la politique livrée, pas celle du développement

Première tentative : poser la CSP partout. L'application ne s'affichait plus —
le serveur de Vite injecte ses propres scripts **en ligne** pour le rechargement
à chaud, et `script-src 'self'` les refuse. À juste titre.

La tentation est d'assouplir la politique en développement.

> ⚠️ C'eût été le pire choix : on aurait éprouvé une politique **qui n'est pas
> celle qui part en production**.

La politique est donc posée sur l'**artefact livré**, et le banc le **construit
puis le sert** avant de l'éprouver.

---

## 6. Trois défauts du banc, tous de la même famille

Ce chapitre en compte plus que le code qu'il teste — et c'est instructif.

**① Il réussissait sur une politique vide.** « ne contient pas `unsafe-inline` »
est vrai d'une chaîne vide. Le banc annonçait une protection là où il n'y avait
**rien**.

> Un test qui réussit quand la chose est absente est pire qu'un test manquant :
> il rassure.

**② `includes("unsafe-eval")` était vrai pour `'wasm-unsafe-eval'`** — l'inverse
de ce qu'il visait. C'est la **troisième fois** dans ce projet qu'une
correspondance partielle attrape autre chose : après `/Activer/` qui attrapait
« Désactiver ».

> On compare des **jetons entiers**, pas des morceaux de chaîne.

**③ Un backend arrêté était imputé à `connect-src`.**

> Un banc qui attribue mal une panne coûte plus qu'un banc absent : il envoie
> chercher au mauvais endroit, avec confiance.

Une sonde préalable le dit maintenant en une ligne.

---

## 7. Le mobile, et ce qu'il a de mieux que le web

Les services Dart sont écrits : coffre, identités, sessions, pré-clés, code de
sécurité.

Sur un point, **le mobile est meilleur** :

| | web | mobile |
|---|---|---|
| protection des clés | `CryptoKey` non extractible | coffre **matériel** (Keystore / Keychain) |

Une copie du disque ne suffit pas à sortir les clés d'un téléphone.

⚠️ **Ce code est analysé sans erreur, mais n'a pas tourné sur un téléphone.**
L'APK n'est pas construit localement. C'est la limite honnête de ce qui a été
fait, et elle est écrite dans le fichier lui-même.

---

## 8. Où nous en sommes

| | |
|---|---|
| Lots 0 à 3 | ✅ |
| **4.0 — interopérabilité web ↔ mobile** | ✅ **(ce chapitre)** |
| **4.2–4.6 — services Dart** | ✅ écrits, analysés, **non éprouvés sur appareil** |
| **5.2 — CSP stricte** | ✅ **(ce chapitre)** |
| 5.1 — bibliothèque web non maintenue | 🔴 ouvert |
| 6 — ce qui manque pour dire « fini » | ⏳ |

---

## 9. Ce qu'il faut retenir

1. **Le ticket qui peut tout faire tomber passe en premier.** Deux jours de test
   valent mieux que trois semaines d'interface à jeter.

2. **Un protocole se prouve dans les deux sens.** Qui ne marche que dans un sens
   ne marche pas.

3. **Vérifiez explicitement ce qui est implicite** — un octet de préfixe se
   signale mal quand il manque.

4. **Une duplication volontaire se garde honnête par un test qui compare les deux
   copies.**

5. **Détruire à tort la confiance est un défaut de sécurité**, même sans fuite.

6. **Une protection qui casse ce qu'elle protège est pire que pas de
   protection** : elle rassure.

7. **Testez l'artefact livré**, jamais une version assouplie pour le confort du
   développement.

8. **Comparez des jetons entiers.** Une correspondance partielle finit toujours
   par attraper autre chose.

9. **Un banc qui attribue mal une panne coûte plus qu'un banc absent.**
