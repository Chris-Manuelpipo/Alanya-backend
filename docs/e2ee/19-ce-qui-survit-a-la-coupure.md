# Chapitre 19 — Ce qui survit à la coupure

> **Où nous en sommes.** 28/09/2026, soir. Une relecture complète des trois
> dépôts a trouvé une trentaine de défauts, rangés en quatre lots. Voici le
> lot D, celui de la **fiabilité** : ce qui se perd quand un onglet se ferme,
> quand Android tue l'application, quand deux copies du même état divergent,
> quand une restauration réécrit le passé.
>
> Web `e37f9b1` — mobile `f98152a`, `a997f52`.

---

## 1. Deux onglets, deux vérités

Le coffre du navigateur est **chargé en mémoire** à l'ouverture de la page. La
bibliothèque Signal exige des lectures synchrones, IndexedDB est asynchrone : on
lit donc tout au démarrage et l'on sert la suite depuis la mémoire (chapitre 4).

Ce choix a une conséquence qu'on n'avait pas regardée : **deux onglets du même
compte ont chacun leur copie**, et aucun ne relit ce que l'autre écrit.

| instant | onglet 1 (mémoire) | disque | onglet 2 (mémoire) |
|---|---|---|---|
| ouverture | compteur 7 | 7 | compteur 7 |
| l'onglet 1 écrit à Bob | **8** | 8 | 7 |
| l'onglet 2 écrit à Bob | 8 | 8 | **8** — même clé de message ! |

Bob déchiffre le premier message, puis refuse le second : pour lui, le
compteur 8 a déjà servi. **Le message est perdu**, et une clé de message a servi
deux fois — ce que le Double Ratchet existe précisément pour empêcher.

### Le correctif, en deux moitiés

1. **Un verrou partagé par les onglets** : `navigator.locks.request(…)`. Une
   seule opération du protocole à la fois, tous onglets confondus.
2. **Relire ce que l'autre a écrit.** Chaque écriture pose, *dans la même
   transaction*, un **jeton de génération** au hasard. Une fois le verrou pris,
   si le jeton du disque n'est plus celui qu'on connaît, on recharge la copie.

> ⚠️ **Le verrou seul ne suffit pas.** Il empêche deux écritures simultanées,
> mais l'onglet 2, servi en second, chiffrerait toujours depuis sa copie
> périmée. Ordonner n'est pas synchroniser.

> ⚠️ **Un jeton au hasard, pas un compteur.** Deux onglets qui incrémentent le
> même compteur depuis la même valeur écrivent le même nombre, et chacun croit
> l'autre à jour.

> ⚠️ **Le rechargement se fait à côté, puis d'un coup.** Vider la mémoire puis
> la remplir au fil des déchiffrements laisserait, pendant ces `await`, un
> coffre sans identité à qui le lirait — et un coffre sans identité en génère
> une neuve (chapitre 4, encore).

**Erreur rencontrée en l'écrivant** : les deux requêtes IndexedDB (le secret et
le jeton) étaient d'abord lancées l'une après l'autre, avec un `await` entre
les deux. Une transaction IndexedDB se referme dès qu'elle n'a plus de requête
en cours : la seconde aurait pu tomber sur une transaction close. Elles partent
désormais ensemble (`Promise.all`).

Preuve : `STAGE-WEB/scripts/e2ee-onglets.mjs` — le message de l'onglet 2 était
perdu ; il est lu.

---

## 2. Ranger avant de passer au suivant

Un message chiffré **ne se déchiffre qu'une fois** : le cliquet avance, la clé
est détruite. Le texte n'existe donc qu'en un endroit après le déchiffrement : la
mémoire du programme. S'il n'est pas écrit, il est perdu.

Les deux clients faisaient :

```
pour chaque enveloppe : déchiffrer          ← jusqu'à 200
puis : tout ranger d'un coup
puis : acquitter
```

Entre la première et la dernière ligne, Android peut tuer l'application, et
l'utilisateur peut fermer l'onglet. Tout ce qui était déchiffré était perdu, et
la relève suivante le prenait pour « déjà lu ».

Le correctif est une simple question d'ordre : **ranger chaque message juste
après l'avoir déchiffré**. La fenêtre de perte passe de deux cents messages à
un seul.

> ⚠️ **Le rapport de relecture proposait autre chose** : « ne pas acquitter un
> message dont le rangement a échoué ». Le code disait déjà pourquoi c'est
> inutile : garder l'enveloppe ne sauve rien, puisqu'elle ne se déchiffrera
> plus. Une recommandation plausible n'est pas une recommandation juste —
> **lire le commentaire qui explique le choix avant de le défaire.**

**Comment le prouver ?** On ne tue pas un programme au milieu d'une boucle à coup
sûr. On éprouve donc la **propriété** qui ferme la fenêtre : le rangement est
appelé une fois par message, jamais sur un lot. Avant : `[3]`. Après :
`[1, 1, 1]`. (`e2ee-onglets.mjs` ⑥, `test/e2ee_releve_test.dart` ③.)

---

## 3. La restauration qui réécrivait le passé (mobile)

L'archive chiffrée garde une copie de chaque texte. Le mobile la relit au
démarrage dès qu'elle a grossi — donc après chaque envoi. Il rangeait chaque
message par `upsert`, c'est-à-dire `INSERT OR REPLACE` : **la ligne entière**
était remplacée.

| ce que la ligne portait | après restauration |
|---|---|
| supprimé pour tous (`deleted_at`) | **effacé** → le message ressort en clair |
| éphémère (`expires_at`) | **effacé** → il ne disparaît plus jamais |
| « lu » | « envoyé » |
| réponse citée, mentions | perdues |

Et une ligne **retirée** (« supprimer pour moi », éphémère expiré) était
recréée : rien ne se souvenait qu'elle était partie.

### Le correctif

Une règle pure, `gesteRestauration`, qui dit ce qu'une ligne d'archive a le
droit de faire :

| situation | geste |
|---|---|
| effacée de cet appareil | rien |
| absente | l'insérer |
| supprimée pour tous | rien |
| texte déjà connu | rien |
| présente sans texte | compléter le texte, **et rien d'autre** |

Pour la première ligne du tableau, il fallait une **mémoire de l'effacement** :
une table `effaces` (un identifiant, rien de plus), remplie par la suppression et
par la purge des éphémères. Cache SQLite v6.

> 🔴 **Le même trou, par une autre porte.** Une enveloppe peut arriver *après*
> la suppression — destinataire hors ligne. `rangeTexteDechiffre` et la fusion
> à l'écran remettaient alors le texte dans la ligne supprimée. Même règle,
> même correctif.

**Comment le SQL a été prouvé** : les tests Flutter n'ont pas de SQLite. On a
rejoué les *mêmes requêtes* avec `node:sqlite` (Node 24), ancien code puis
nouveau, sur sept scénarios. Ancien : six échecs sur huit contrôles. Nouveau :
huit sur huit.

> ⚠️ **Limite assumée.** Un appareil *neuf* qui restaure n'a aucune mémoire
> des effacements. Les messages supprimés pour tous se corrigent à l'ouverture
> du fil — le serveur les rend supprimés —, sauf ceux plus anciens que la page
> chargée. Fermer ce reste demanderait que le serveur dise quels messages
> n'existent plus.

---

## 4. Deux défauts plus petits

**La reprise figée à 2 000 blocs (mobile).** Pour savoir si l'archive avait
grossi, le mobile comptait les blocs de la *première page*, plafonnée à 2 000.
Au-delà, le compte ne bougeait plus : la reprise croyait n'avoir rien de neuf,
pour toujours. Le serveur donne `totalArchive` ; on le lit.

**Vérifier un appareil blanchissait tout le compte (web).** L'alerte « nouvel
appareil » est rangée par compte. Comparer le code d'*un* appareil l'effaçait
entièrement : un appareil fantôme ajouté au même moment restait invisible.
Désormais, elle ne s'efface que quand **tous** les appareils sont vérifiés.

---

## 5. Ce qui n'a pas été corrigé, et pourquoi

**L'alerte pour ses propres appareils.** Un appareil ajouté à *mon* compte reçoit
une copie de mes messages sans alerte. Les deux clients l'excluent **exprès**
(« mes appareils s'ajoutent de mon fait »), et l'alerte actuelle est attachée à
une conversation — ce qu'un compte n'est pas. Il faut d'abord décider **où**
l'afficher : c'est une décision de produit, soumise au user.

**Le test de parité des traductions était rouge** — depuis le lot 4 « téléphone
lié » du matin même, qui n'avait traduit que deux langues sur neuf. Personne ne
l'a vu : **la CI mobile ne lance pas `flutter test`**. C'est la troisième fois
que ce trou laisse passer un défaut (registre, « ce qui manque encore »).

---

## 6. À retenir

1. **Une copie en mémoire est un cache, et un cache se périme.** Dès qu'il y a
   deux copies, il faut dire laquelle fait foi et comment l'autre l'apprend.
2. **Ordonner n'est pas synchroniser.** Un verrou sans relecture laisse chacun
   travailler sur sa vieille copie, simplement à tour de rôle.
3. **Ce qui ne se refait pas s'écrit tout de suite.** Un déchiffrement est
   irréversible : son résultat doit toucher le disque avant l'étape suivante.
4. **Une restauration ajoute, elle ne corrige pas.** Elle ne connaît que le
   passé ; tout ce qui a changé depuis — suppression, lecture, expiration —
   est plus juste qu'elle.
5. **Un effacement est une information.** Quand la ligne part, quelque chose
   doit se souvenir qu'elle est partie.
