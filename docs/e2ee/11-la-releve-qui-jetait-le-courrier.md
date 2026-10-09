# Chapitre 11 — La relève qui jetait le courrier

> **Où nous en sommes.** Le chiffrement tourne sur le web et sur le mobile. Une
> analyse complète du 28/09/2026 relit tout le code, et trouve que le point le
> plus fragile n'est ni la cryptographie ni le serveur : c'est la **relève**,
> le moment où un appareil vient chercher ses messages.
>
> Trois défauts, tous invisibles à l'écran, tous prouvés **avant** d'être
> corrigés.
>
> Branches `feat/e2ee` (web, `d8a7eb8` et `fa8c882`) et
> `feat/chip-appel-callstyle` (mobile, `3e4ffbb`).

---

## 1. Rappel : ce qu'est une relève

Un message chiffré n'est pas stocké dans `message.content`. Le serveur garde une
**enveloppe** par appareil destinataire, dans `e2ee_enveloppes`. Pour lire, un
appareil fait trois gestes :

```
  ① GET    /api/e2ee/enveloppes?deviceId=N     ← tout ce qui m'attend
  ② déchiffrer, localement
  ③ DELETE /api/e2ee/enveloppes?ids=a,b,c      ← « je les ai »
```

Deux propriétés du protocole rendent cet enchaînement délicat :

> 🔴 **Un message ne se déchiffre qu'UNE fois.** Le Double Ratchet détruit la
> clé du message dès qu'elle a servi. Un second essai échoue — même avec la
> bonne session.

> 🔴 **Après ③, le serveur n'a plus rien.** L'appareil est alors le seul au
> monde à détenir ce texte.

Retenez ces deux phrases : les trois défauts de ce chapitre en découlent.

---

## 2. Défaut A — le courrier des autres boîtes

### Ce qu'on voyait

Rien de grave, en apparence. Parfois une bulle affichait « Message chiffré —
indisponible sur cet appareil ». Un commit récent l'avait même présentée comme
**« un état légitime, pas une panne »**.

### Ce que c'était

La relève ① rend les enveloppes de **toutes** les conversations — la route ne
prend pas de `convId`. Le code faisait :

```ts
const clairs = await releverEtDechiffrer()   // tous les fils, tous acquittés
for (const m of messagesDeCeFil) {           // …mais on ne range que CE fil
  m.content = clairs.get(m.id)
  cacheMessage(m)
}
```

Bob a ouvert sa conversation avec Carole. Alice lui écrit dans **une autre**
conversation. Puis Carole écrit : la relève de Bob ramène les deux enveloppes,
déchiffre les deux, **acquitte les deux** — et ne range que celle de Carole.

Le texte d'Alice est perdu. Pas « pas encore arrivé » : **perdu**. Le serveur
l'a effacé, la clé est consommée.

### Pourquoi rien ne l'a vu

- Tous les bancs n'avaient **qu'une seule** conversation chiffrée. Le défaut
  exige un second fil actif.
- Le libellé « indisponible sur cet appareil » décrit un cas réel (un message
  envoyé avant que cet appareil existe). Il décrivait **aussi** celui-ci, et
  l'a rendu invisible.

> ⚠️ **Un message d'état qui couvre deux causes cache toujours la mauvaise.**
> C'est le motif ⑤ du registre : le texte qui affirme plus que le code.

### La preuve, avant de corriger

`STAGE-WEB/scripts/e2ee-releve-multifil.mjs` rejoue exactement le scénario, dans
le vrai Chrome, avec trois comptes :

```
④ Bob ouvre le fil d'Alice
  ✗ le texte d'Alice est affiché
⑤ Et il survit à un rechargement
  ✗ toujours là après rechargement
      (l'enveloppe d'Alice est ACQUITTÉE sur le serveur)
```

### Le correctif

Le rangement ne peut pas être la responsabilité de l'écran, puisque l'écran ne
connaît qu'un fil. Il passe **dans la relève**, et **avant** l'acquittement :

```ts
export async function releverEtDechiffrer(ranger?) {
  // ① relever  ② déchiffrer
  await ranger(tousLesMessages)   // chacun dans le cache de SON fil
  // ③ acquitter
}
```

Côté web, `e2ee-releve.ts` fournit ce rangement ; côté mobile,
`PileE2ee.releverEtRanger()`. Les écrans n'appellent plus que ces deux-là.

> 🔴 **Ce n'est pas l'enveloppe qui protège le texte, c'est le rangement.** On
> croyait « acquitter après avoir déchiffré » suffisant. Mais déchiffré n'est
> pas rangé.

### Deux défauts trouvés en chemin

**Le ré-archivage.** La boucle d'affichage archivait tout message dont elle
connaissait le texte — y compris ceux relus dans le cache. Ouvrir un fil
chiffré renvoyait donc ses trente derniers messages à l'archive : trois blocs
de doublons par ouverture. Or le serveur ne rend que 2 000 blocs à la
restauration.

**Le `putConv` du mobile.** Il **vide** toutes les lignes d'un fil avant d'y
écrire la liste affichée. Placé après le rangement, il aurait effacé ce que
celui-ci venait d'écrire, pour tout message pas encore à l'écran.

> ⚠️ **Déplacer une responsabilité oblige à relire tous ceux qui l'exerçaient
> déjà.** Le rangement neuf était juste ; deux anciens gestes le défaisaient.

---

## 3. Défaut B — deux facteurs pour une seule lettre

### Ce qu'on voyait

Sur mobile : « 1 message chiffré illisible — la session a été réinitialisée »,
alors que rien n'avait changé chez personne. Puis le message **suivant** du
correspondant, illisible lui aussi.

### Ce que c'était

L'écran du mobile lance une relève dans trois cas, sans jamais attendre la
précédente :

```dart
unawaited(_releverChiffres());   // à l'ouverture du fil
unawaited(_releverChiffres());   // à l'arrivée de la ligne du message
unawaited(_releverChiffres());   // à la sonnette `e2ee_arrivee`
```

Les deux derniers partent **pour le même message**, à quelques millisecondes.

```
  relève 1 : GET → [enveloppe X]         relève 2 : GET → [enveloppe X]
  relève 1 : déchiffre X  ✓
                                          relève 2 : déchiffre X  ✗  (clé déjà détruite)
                                          relève 2 : « illisible » → EFFACE LA SESSION
  relève 1 : acquitte X
```

La première a lu le message. La seconde, arrivée trop tard, a pris son propre
échec pour une panne de session — et a effacé une session parfaitement saine.

### Un second étage : le coffre sans verrou

Le coffre mobile range ses pré-clés et ses sessions en **tables entières** :
chaque écriture relit la table, la modifie, la réécrit. Deux opérations
entrelacées écrivent chacune leur version, et la dernière efface l'autre.

> ⚠️ **Le web n'a pas ce problème, et c'est pour cela qu'on ne l'avait pas
> vu** : sa bibliothèque sérialise elle-même les opérations par correspondant
> (`SessionLock`). Celle du mobile ne le fait pas. Deux clients « jumeaux » ne
> le sont que pour ce qu'on a vérifié.

### La preuve

`alanya/test/e2ee_releve_test.dart` fait tourner le **vrai** code du mobile —
coffre, service, fil, bibliothèque Signal — sans APK. Seuls le stockage
sécurisé (`setMockInitialValues`) et le serveur sont simulés.

```
① deux relèves lancées ensemble
  ✗ ne déchiffrent pas deux fois le même message     (Expected: 0, Actual: 1)
  ✗ et la session survit : le message suivant se lit (Actual: [])
```

⚠️ **Un détail sans lequel le test aurait menti** : le faux serveur attend un
tour de boucle (`Future.delayed(Duration.zero)`) à chaque appel. Sans lui, deux
relèves lancées « ensemble » s'exécuteraient l'une après l'autre, et le test
passerait sur le code fautif.

### Le correctif

- Les relèves passent **une par une** (une file, pas une relève partagée : un
  appel arrivé en cours de route peut viser une enveloppe déposée après le
  départ de la relève en cours).
- `E2eeService` sérialise **tout accès en écriture** au coffre.

---

## 4. Défaut n° 4 — la lettre piégée qu'on relit chaque matin

### Ce que c'était

Une enveloppe qui échouait n'était **jamais acquittée**, « pour ne pas la
perdre ». Elle revenait donc à chaque relève. Sur mobile, chaque échec effaçait
la session :

```
  X illisible → session effacée
  le correspondant rétablit une session neuve
  relève suivante : X encore là, encore illisible → session NEUVE effacée
  … pendant 90 jours, durée de vie d'une enveloppe non relevée
```

Sur le web, pas d'effacement, mais une autre impasse : la relève ne rend que
200 enveloppes. Deux cents illisibles en tête de file, et plus rien n'arrive.

### L'erreur de raisonnement

« Garder pour ne pas perdre » est une bonne règle **quand réessayer peut
réussir**. Ici, non : un message dont la clé ou la session n'existe plus ne se
lira pas mieux demain.

> 🔴 **La bonne question n'est pas « est-ce prudent ? » mais « prudent envers
> quoi ? »** — c'est le motif ⑥ du registre, et on retombe dedans.

### Le correctif : classer les échecs

| Nature | Exemple | On acquitte ? | On efface la session ? |
|---|---|---|---|
| **déjà lu** | message en double | oui | non |
| **passager** | coffre trop lent, panne du stockage | **non** | non |
| **définitif** | tout le reste | oui | une fois par relève |

⚠️ **La liste est écrite à l'envers.** La bibliothèque Dart n'exporte pas
`InvalidMessageException` : on ne peut pas la nommer. On nomme donc ce qui est
passager, et tout le reste est définitif. Sur le web, le départage se fait en
ouvrant le coffre **hors de la boucle** : s'il ne s'ouvre pas, rien n'est
acquitté.

---

## 5. Une erreur de l'analyse elle-même

La première lecture du code avait classé en 🔴 un autre défaut : « le web
refait une session à chaque envoi, d'où les messages illisibles ».

Relecture de la bibliothèque :

```js
record.archiveCurrentState();   // l'ancienne session n'est pas jetée…
record.updateSessionState(session);
// … et au déchiffrement, TOUTES les sessions gardées sont essayées (40 max)
```

Le défaut existe — une pré-clé brûlée à chaque message, un cliquet qui ne sert
jamais — mais il ne rend **pas** les messages illisibles. La cause réelle des
illisibles, c'était B.

> ⚠️ **Une analyse par lecture produit des hypothèses, pas des verdicts.** Celle
> qui paraissait la plus grave était fausse ; celle qui l'était vraiment ne
> s'est révélée qu'en lisant l'écran qui appelait le code.

---

## 6. Ce qui reste vrai, et ce qui ne l'est pas encore

| | |
|---|---|
| ✅ Web : A et n° 4 prouvés puis corrigés | banc Chrome, 11 contrôles |
| ✅ Mobile : A, B et n° 4 prouvés puis corrigés | `flutter test`, 4 tests, 189 au total |
| ⏳ Mobile sur un appareil réel | jamais exécuté — l'APK se construit en CI |
| ⏳ Messages déjà perdus | irrécupérables : leur clé n'existe plus |

---

## 7. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « On acquitte après avoir déchiffré : rien ne se perd » | Déchiffré n'est pas **rangé** |
| « La relève sert le fil qu'on regarde » | Elle ramène **tous** les fils |
| « Deux relèves, c'est juste un appel de trop » | La seconde **détruit** la session |
| « Garder l'illisible, c'est prudent » | C'est la relire **pour toujours** |
| « Web et mobile sont jumeaux » | Leurs bibliothèques ne se protègent pas pareil |

Et la règle qui les traverse :

> 🔴 **Dans un protocole où lire consomme, chaque lecture est un transfert de
> propriété.** Avant de dire « je l'ai » au serveur, il faut l'avoir **mis
> quelque part**.
