# Chapitre 17 — La seule copie

> **Où nous en sommes.** 28/09/2026, après les six lots. Le user demande que la
> liste des conversations montre le dernier message d'un fil chiffré. En
> analysant cette fonctionnalité, on tombe sur un défaut plus grave, qui
> n'avait rien à voir avec elle : **le téléphone effaçait lui-même des messages
> qu'il était le seul à posséder.**
>
> Mobile `3618007` (la liste) — `7ed49e8` (lot A) — `915bab5` (lot B).

---

## 1. Où vit le texte d'un message chiffré ?

Posons la question simplement : quand Bob reçoit « rendez-vous à 14 h » dans un
fil chiffré, **où ce texte existe-t-il** ?

| endroit | le texte y est ? |
|---|---|
| le serveur | ❌ il garde la ligne du message, **sans contenu** |
| l'enveloppe | ❌ acquittée puis supprimée juste après la relève |
| la clé qui l'a ouvert | ❌ le cliquet l'a consommée : on ne peut plus rouvrir |
| **le cache local du téléphone** | ✅ **seul endroit** |
| l'archive chiffrée | ✅ une copie de secours, si elle est ouverte |

C'est voulu : c'est même toute la promesse du chiffrement de bout en bout.
Mais cela change le statut du cache local. Pour un fil ordinaire, le cache est
une **copie** du serveur : on peut le jeter, le serveur redonnera tout. Pour un
fil chiffré, le cache est **l'original**.

> 🎯 **Idée centrale du chapitre.** Un code écrit quand le cache était une
> copie traite le cache comme une copie. Il faut relire chaque écriture avec
> la nouvelle question : *est-ce que ceci peut détruire la seule copie ?*

---

## 2. Deux écritures qui détruisaient

### `putConv` — ouvrir la conversation

À l'ouverture d'un fil, l'application demande au serveur la dernière page de
messages, puis la range dans le cache. Le code d'origine :

```dart
// Supprime les anciens messages de cette conversation.
batch.delete('messages', where: 'conv_id = ?', whereArgs: [convId]);
// Insère les nouveaux.
```

Pour un fil ordinaire : parfait, le cache colle au serveur. Pour un fil
chiffré : **tout texte plus ancien que la page disparaît**. Ouvrir une
conversation suffisait à perdre son historique déchiffré.

### `upsert` — remonter l'historique

En remontant le fil, l'application charge une page plus ancienne et range
chaque message avec `ConflictAlgorithm.replace` : la ligne **entière** est
remplacée par la version du serveur… dont le contenu est nul. Le texte était
écrasé, et la bulle s'affichait vide.

### Pourquoi personne ne l'avait vu

Parce que le défaut **ne se voit pas tout de suite**. Juste après la relève,
le texte est là. Il disparaît à la *prochaine* ouverture, et seulement pour les
messages sortis de la dernière page. Aucun test ne vérifiait « le texte est-il
encore là après une réouverture ? ».

---

## 3. La correction : une règle pure

Plutôt que de corriger dans le code SQLite (qui ne tourne pas sous
`flutter test`), la décision est sortie dans une **fonction pure**,
`lib/core/cache_clairs.dart` :

| ligne en cache | décision |
|---|---|
| présente dans la page du serveur | remplacée, **son texte connu recollé** si le serveur n'en a pas |
| chiffrée, avec texte, **plus ancienne** que la page | **gardée** : la page ne dit rien d'elle |
| absente de la page mais **plus récente** que son début | effacée : le message n'existe plus pour nous (masqué, expiré) |
| message supprimé pour tous | son texte part, chiffré ou non |
| page vide | tout part |

La même règle, `texteAEcrire`, protège `upsert`.

---

## 4. L'erreur qu'on a failli introduire

Garder des lignes que l'on effaçait avant a une **conséquence** : tout ce qui
comptait sur cet effacement ne fonctionne plus.

Deux choses en dépendaient **sans le savoir** :

1. **La suppression « pour tout le monde ».** Elle n'était traitée qu'à
   l'écran, conversation ouverte. Le cache n'était jamais corrigé… mais
   `putConv` finissait par effacer la ligne. Désormais gardée, elle serait
   restée **lisible pour toujours**.
2. **Les messages éphémères.** Le serveur les purge **sans rien diffuser**.
   Même mécanisme : effacés par hasard avant, éternels après.

> ⚠️ **Leçon.** Quand on supprime un comportement destructeur, chercher ce qui
> s'appuyait dessus. Un bug peut en masquer un autre ; ici, un effacement trop
> large cachait deux oublis.

D'où, dans le même travail : `appliquerSuppression` (appelée par l'accueil, qui
est toujours présent, et par l'écran de conversation) et une colonne
`expires_at` avec une purge avant chaque lecture.

---

## 5. Le deuxième défaut : deux façons d'écrire l'heure

En corrigeant la liste, un autre problème est apparu. Le cache contenait deux
formes de date :

| origine | forme écrite | instant |
|---|---|---|
| serveur | `2026-09-28T09:30:00.000Z` | 09 h 30 UTC |
| relève (heure du téléphone, Yaoundé) | `2026-09-28T10:14:00.000` | **09 h 14 UTC** |

SQLite trie des **chaînes**, pas des instants. `10:14` passe après `09:30` :
le message **le plus ancien** était désigné comme le dernier. Ce n'est pas une
supposition, c'est **mesuré** sur un vrai SQLite (celui de Node 24) :

```
ancien tri, dernier = releve_09h14Z_ecrit_en_local
```

La correction : une seule forme, `dateCache` — UTC, **à la milliseconde**.

Pourquoi la milliseconde ? Parce que `toIso8601String` n'écrit les
microsecondes **que si elles ne sont pas nulles**. `…36.123Z` et
`…36.123456Z` n'ont pas la même longueur, et `Z` est « plus grand » qu'un
chiffre : l'ordre des chaînes serait à nouveau faux.

Les lignes déjà en cache sont réécrites par la migration v5 : relues par
`DateTime.parse` (qui sait qu'une date sans `Z` est en heure locale), puis
réécrites. On n'a pas confié cette conversion à SQLite : son `'utc'` dépend du
fuseau que la bibliothèque C voit sur le téléphone, ce qu'on ne contrôle pas.

---

## 6. Comment on a prouvé

| quoi | comment | résultat |
|---|---|---|
| la règle de conservation | `test/cache_clairs_test.dart` | 17/17 |
| le tri des dates | test Dart avec deux fuseaux réels | ✅ |
| la requête « une ligne par fil » | exécutée sur SQLite 3.51 : média plus récent, dernier supprimé, dernier expiré | ✅ les trois |
| la sélection de la migration | même banc | ✅ |
| l'ancien tri était faux | même banc | ❌ reproduit |
| sur téléphone | — | **pas encore** |

La requête utilise une particularité de SQLite : avec `MAX()`, les colonnes non
agrégées viennent **de la ligne qui porte le maximum**. C'est documenté
(*bare columns in aggregate queries*), mais ce n'est **pas** du SQL standard :
PostgreSQL refuserait cette requête. Elle ne doit donc jamais être recopiée
côté serveur.

---

## 7. Ce qui reste

- 🟡 Un message chiffré **seulement relevé** (fil jamais rouvert) n'a pas sa
  date d'expiration : l'enveloppe ne la transporte pas. Correctif :
  ajouter `expiresAt` à `GET /api/e2ee/enveloppes`.
- 🟡 Le web a-t-il le même défaut ? **Non vérifié.** Il faut relire ses
  écritures de cache avec la question de la section 1.
- 🔴 Rien de tout cela n'a encore tourné sur un téléphone.

---

## 8. À retenir

1. En chiffrement de bout en bout, **le cache local cesse d'être une copie**.
   C'est souvent l'original.
2. Toute écriture qui « remplace par la version du serveur » est suspecte.
3. Retirer un effacement trop large peut **révéler** des oublis qu'il cachait.
4. Une date sans fuseau dans une colonne triée comme du texte est un défaut en
   attente.
5. On prouve une requête en l'**exécutant**, même hors du téléphone.
