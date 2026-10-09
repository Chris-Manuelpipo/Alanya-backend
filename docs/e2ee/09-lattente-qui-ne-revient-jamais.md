# Chapitre 9 — L'attente qui ne revient jamais

> **Où nous en sommes.** Tout le chiffrement est en place des deux côtés. Et
> pourtant, sur le téléphone, ouvrir une conversation fait tourner un indicateur
> de chargement **sans fin**.
>
> Ce chapitre raconte trois diagnostics successifs dont **deux étaient justes et
> insuffisants**, et la règle qui aurait évité les trois.
>
> Branche `feat/chip-appel-callstyle`.

---

## 1. Le symptôme

On ouvre une conversation. Le rond tourne. Il tourne encore. Il ne s'arrêtera
pas.

Les messages existent — on les a envoyés, le web les voit. Ils ne s'affichent
simplement jamais.

---

## 2. Premier diagnostic : les pré-clés (juste, insuffisant)

Au démarrage, le mobile publiait cinquante pré-clés et les écrivait **une par
une** dans le coffre sécurisé. Cinquante écritures sur le canal de plateforme,
la file d'attente unique par laquelle Flutter parle au système.

> ⚠️ Le coffre sécurisé n'est pas une base de données. Chaque lecture et chaque
> écriture est un aller-retour vers le code natif, et ces allers-retours se
> mettent **en file**.

Or l'écran de conversation commençait par lire le jeton d'authentification…
dans ce même coffre. Sa lecture passait donc derrière cinquante écritures.

**Corrigé** : les pré-clés tiennent désormais dans une seule entrée, et on ne
les publie qu'une fois.

Le chargement infini a continué.

---

## 3. Deuxième diagnostic : l'ordre (juste, insuffisant)

L'écran faisait, dans cet ordre :

```
  ① lire le jeton          (coffre sécurisé — lent)
  ② lire le cache local    (les messages sont DÉJÀ là)
  ③ appeler le serveur
```

Le cache contenait les messages. Ils auraient pu s'afficher immédiatement. Ils
attendaient derrière une lecture de coffre dont ils n'avaient aucun besoin.

> 🔴 **Aucun affichage ne doit dépendre d'une lecture de coffre sécurisé.** Le
> jeton ne sert qu'aux appels réseau qui suivent.

**Corrigé** : le cache d'abord, le jeton ensuite.

Le chargement infini a continué.

---

## 4. Le vrai coupable : une requête sans délai

```dart
final res = await http.get(uri, headers: ...);   // ← rien ne borne cette attente
```

> 🔴 **`package:http` n'a aucun délai par défaut.**

Une requête dont la réponse n'arrive jamais — réseau coupé *après*
l'établissement de la connexion, serveur muet, portail wifi d'hôtel qui avale
les paquets — attend **indéfiniment**. Son `Future` ne se termine ni en succès
ni en erreur.

Et c'est là qu'est la leçon du chapitre :

> ⚠️ **Un `try/catch` ne protège pas d'une attente sans fin.** Il n'attrape que
> ce qui est **levé**. Une attente qui ne revient pas ne lève rien : le `catch`
> ne s'exécute jamais.

Le code avait pourtant l'air prudent :

```dart
try {
  final msgs = await repo.getMessages(convId);
  setState(() => _loading = false);
} catch (_) {
  setState(() => _loading = false);   // « on a couvert le cas d'erreur »
}
```

Les deux branches éteignent l'indicateur. Aucune des deux ne s'exécute si
`getMessages` ne revient pas. **Le code ne plante pas : il s'arrête.**

C'est un défaut plus difficile à voir qu'un plantage, précisément parce qu'il
ne produit aucune trace. Pas d'exception, pas de journal, pas de rapport de
panne. Juste un rond qui tourne.

---

## 5. La correction, en trois couches

### Couche 1 — le client HTTP

```dart
static const Duration delaiReponse = Duration(seconds: 30);

final res = await http
    .get(uri, headers: _headers(bearer))
    .timeout(delaiReponse, onTimeout: _expire);
```

Le délai vit **dans le client**, pas dans chaque écran — sinon il manquera
partout où on aura oublié de le mettre.

`_expire` lève une `ApiException(408)` et non une `TimeoutException` : toute
l'application sait déjà traiter la première ; la seconde serait un type de plus
à attraper dans chaque écran.

> ⚠️ **Les envois de médias en sont exclus.** Téléverser une vidéo de dix
> mégaoctets dépasse légitimement trente secondes. Les couper transformerait une
> lenteur normale en échec.

### Couche 2 — les lectures locales

Le coffre sécurisé *et* le cache `sqflite` passent tous deux par le canal de
plateforme. La lecture de cache qui doit nous **sauver** de l'attente peut
elle-même attendre.

```dart
final cached = await MessageCache.getConv(convId)
    .timeout(const Duration(seconds: 3), onTimeout: () => const []);

_token = await tokenStorage.accessToken
    .timeout(const Duration(seconds: 5), onTimeout: () => null);
```

Cinq secondes sans réponse du coffre, c'est déjà une panne. Mieux vaut continuer
sans jeton — les appels réseau échoueront proprement — que laisser l'écran
tourner à vide.

### Couche 3 — le filet

```dart
} finally {
  if (mounted && _loading) setState(() => _loading = false);
}
```

> ⚠️ **Un indicateur de chargement s'éteint dans un `finally`, jamais ailleurs.**
>
> - à la fin du `try` → le cas d'erreur reste découvert ;
> - dans le `catch` → le cas du `return` anticipé reste découvert ;
> - dans le `finally` → les trois sorties sont couvertes.

Les couches 1 et 2 traitent **des causes**. La couche 3 traite le **symptôme**,
et c'est volontaire : tant qu'un seul chemin peut sortir de la fonction sans
éteindre l'indicateur, la prochaine cause sera découverte en production.

---

## 6. Pourquoi il a fallu trois tours

Les deux premiers diagnostics étaient **justes**. Ils ont retiré de vraies
lenteurs. Ils n'ont pas corrigé le défaut, parce qu'ils s'attaquaient à *ce qui
était lent* au lieu de *ce qui n'était pas borné*.

> 🔴 La bonne question n'est pas « qu'est-ce qui est lent ? » mais **« qu'est-ce
> qui peut ne jamais revenir ? »**

Une chose lente finit. Une chose non bornée, non.

Faites la liste des `await` qui précèdent l'extinction de votre indicateur. Pour
chacun, demandez-vous s'il existe un cas — même rare, même absurde — où il ne
rend jamais la main. Réseau, canal de plateforme, verrou, flux : tous les quatre
en ont un.

---

## 7. La cause derrière la cause : rien n'arrivait sur l'appareil

Un détail a coûté un tour supplémentaire à lui seul.

L'APK vient de la CI ; personne ne construit en local. Or la dernière
construction **échouait**, sur ceci :

```dart
'fr': {
  'call_reconnecting': 'Reconnexion…',   // ligne 312
  ...
  'call_reconnecting': 'Reconnexion…',   // ligne 4871
}
```

Deux branches avaient ajouté le même bloc de traductions à des endroits
différents du fichier. **Git ne voit aucun conflit** : les deux ajouts sont à
des lignes distinctes.

> ⚠️ **`flutter analyze` ne peut pas voir ce défaut.** Une clé répétée dans une
> `const Map` n'échoue qu'à l'**évaluation des constantes**, c'est-à-dire à la
> compilation. L'analyseur, lui, ne fait que lire le code.

Conséquence : les deux premières corrections étaient poussées, mais **aucune
n'était jamais arrivée sur le téléphone**. On corrigeait à l'aveugle un défaut
qu'on croyait persistant.

### Le banc qui ferme la porte

`outils/doublons_traductions.py` parcourt chaque table de langue et refuse les
clés répétées. Il tourne en CI **avant** Gradle : trente secondes ici évitent
dix minutes de construction pour rien.

Deux détails qui font la différence entre un banc et un banc utile :

```python
if not debuts:
    print("ECHEC : aucune table de langue reconnue")
    return 1
```

> 🔴 **Un banc qui passe à vide ne prouve rien.** Si le format du fichier change
> et que plus aucune table n'est reconnue, il doit échouer — pas annoncer
> « aucun doublon ».

Et on l'éprouve : doublon injecté volontairement → détecté, code de sortie 1,
fichier restauré. Un détecteur qu'on n'a jamais vu détecter n'est pas un
détecteur.

---

## 8. À retenir

| Croyance | Réalité |
|---|---|
| « Le `try/catch` couvre tout » | Il ne couvre que ce qui est **levé** |
| « `http` a un délai raisonnable » | Il n'en a **aucun** |
| « Le cache local est instantané » | Il passe par le **canal de plateforme** |
| « L'analyseur voit les erreurs » | Pas celles de l'**évaluation des constantes** |
| « C'est poussé, donc c'est testé » | Pas si la **CI échoue** |

Et la règle unique qui les résume :

> 🔴 **Tout `await` qui précède l'extinction d'un indicateur de chargement doit
> avoir une borne, et l'extinction doit vivre dans un `finally`.**
