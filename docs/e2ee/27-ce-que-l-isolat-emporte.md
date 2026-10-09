# Chapitre 27 — Ce que l'isolat emporte

> **Où nous en sommes.** 04/10/2026. Le téléphone envoie des médias chiffrés
> depuis le lot C (chapitre 25). Depuis le 03/10 au soir, l'écran montre
> aussi une vignette et un pourcentage pendant l'envoi. Ce chapitre explique
> pourquoi cette petite amélioration a cassé l'envoi, et comment on l'a réparé.
>
> Mobile seul : commit `b5f5b5e`, branche `feat/chip-appel-callstyle`.

---

## 1. Le symptôme

Sur le téléphone, envoyer une photo dans un fil chiffré affiche :

> Envoi impossible : Invalid argument(s): Illegal argument in isolate message:
> object is unsendable - Library:'dart:async' Class: _Future

suivi d'une longue chaîne :

```
<- Instance of '_ChatScreenState'
<- _ChatScreenState._pickAndSendFile
<- Instance of 'IconButton'
<- … (tout l'arbre des widgets)
```

Rien n'est parti : ni le fichier, ni le message.

## 2. Rappel : pourquoi un isolat

Le chiffrement d'un fichier est écrit en **Dart pur** (`pointycastle`, AES-GCM
par blocs de 64 Ko, chapitre 23). Sur une vidéo de 50 Mo, il occupe le
processeur plusieurs secondes. S'il tournait sur le fil de l'écran, l'écran
serait figé pendant tout ce temps.

On le lance donc dans un **isolat** : un second fil d'exécution qui a **sa
propre mémoire**. Comme les deux mémoires sont séparées, tout ce que l'isolat
doit utiliser lui est **envoyé**, en copie.

```dart
final f = await Isolate.run(() => chiffrerFichier(octets));
```

Ici, on envoie une **fermeture** : `() => chiffrerFichier(octets)`. Il faut
donc envoyer aussi tout ce dont cette fermeture a besoin.

## 3. Le piège : une fermeture n'emporte pas que ses variables

Intuitivement, la fermeture ne parle que de `octets`. On s'attend donc à ce
que seuls les octets voyagent.

**Ce n'est pas ce que fait la machine virtuelle Dart.** Une fonction qui crée
plusieurs fermetures range toutes les variables capturées dans **un seul
objet**, le **contexte**. Chaque fermeture pointe vers ce contexte entier, et
le contexte pointe vers celui de la fonction englobante.

Voici la fonction d'envoi après le 03/10 au soir :

```dart
static Future<Message> envoyer({ …, void Function(double)? onProgression }) async {
  final octets = fichier.bytes;
  …
  final f = await Isolate.run(() => chiffrerFichier(octets));   // fermeture 1
  final envoye = await medias.upload(
    …,
    onProgress: (envoyes, total) => onProgression(envoyes / total), // fermeture 2
  );
```

- La fermeture 1 capture `octets`.
- La fermeture 2 capture `onProgression`.
- Les deux variables vivent donc dans **le même contexte**.

Quand on envoie la fermeture 1, son contexte part avec elle, **y compris
`onProgression`**.

Il faut alors suivre la chaîne :

| Objet envoyé | Ce qu'il tient |
|---|---|
| `onProgression` | une fermeture créée dans `_pickAndSendFile` |
| son contexte | `this`, c'est-à-dire `_ChatScreenState` |
| `_ChatScreenState` | l'arbre des widgets, des contrôleurs… et un `Future` |
| `_Future` | **interdit à l'envoi** |

C'est exactement la chaîne affichée par l'erreur, lue de bas en haut.

## 4. Pourquoi ça marchait avant

Le lot C (`05c7c3e`) avait déjà ce même `Isolate.run`. Mais à ce moment-là,
`envoyer` ne créait **aucune autre fermeture** : le contexte ne contenait que
`octets`.

Le commit `0de303a` (03/10) a ajouté le suivi de progression. Ça a suffi à
introduire la deuxième fermeture, donc à faire entrer l'écran dans le contexte.

**Personne n'a touché à la ligne du chiffrement**, et pourtant c'est elle qui
a cassé. C'est ce qui rend ce défaut traître : le code fautif est **voisin** de
la modification.

## 5. Le correctif : un contexte qui ne contient que les paramètres

On sort l'appel à l'isolat dans une **fonction de haut niveau**, dans
`lib/services/e2ee/e2ee_media.dart` :

```dart
Future<FichierChiffre> chiffrerHorsDuFil(Uint8List clair) =>
    Isolate.run(() => chiffrerFichier(clair));

Future<Uint8List> dechiffrerHorsDuFil(Uint8List chiffre,
    {required String cle, required String empreinte, required int taille}) =>
  Isolate.run(() => dechiffrerFichier(chiffre,
      cle: cle, empreinte: empreinte, taille: taille));
```

Dans ces fonctions, la fermeture a pour seul contexte **les paramètres de la
fonction**. Rien d'autre ne peut s'y glisser, quel que soit l'appelant.

Ces fonctions sont utilisées à trois endroits :

| Endroit | Avant |
|---|---|
| Envoi (`e2ee_media_envoi.dart`) | **cassé** (le symptôme) |
| Ouverture (`e2ee_media_ouverture.dart`) | sain, mais par chance |
| Visionneur de vue unique (`visionneur_vue_unique.dart`) | **défaut en germe** |

Le visionneur appelait `Isolate.run` **dans une méthode d'un `State`**, à côté
de `setState(() => _media = media)`. Ce `setState` capture `this`. Le
visionneur était donc exposé au même défaut.

## 6. Ce qui a été prouvé

Le test `test/e2ee_media_isolat_test.dart` reproduit la situation :

1. **l'ancienne forme** : un `Isolate.run` sur place, à côté d'un rappel qui
   tient un objet contenant un `Future`. Résultat : `ArgumentError`, la même
   erreur que sur le téléphone ;
2. **la nouvelle forme** : même voisinage, mais en passant par
   `chiffrerHorsDuFil`. Le fichier est chiffré, puis déchiffré à l'identique ;
3. `dechiffrerHorsDuFil` rend bien `FichierInvalide` sur une empreinte fausse.

Les tests existants des médias chiffrés passent aussi : 21 sur 21.

**Pas encore vérifié** : un vrai envoi depuis le téléphone, avec l'APK construit
par la CI.

## 7. À retenir

- Un `Isolate.run` emporte **le contexte entier** de la fonction qui l'appelle,
  pas seulement les variables que la fermeture cite.
- Ajouter une fermeture **voisine** peut casser un `Isolate.run` qui n'a pas
  bougé.
- Règle du projet : **jamais d'`Isolate.run` écrit sur place**. Toujours passer
  par une fonction de haut niveau qui ne reçoit que des données simples
  (octets, chaînes, nombres).
- L'erreur affiche **le chemin** de l'objet refusé. Il se lit de bas en haut,
  et désigne directement le coupable.

---

## 8. Deuxième défaut : le PDF qui n'apparaissait qu'en rouvrant le fil

> Mobile, commit `a40e330`. Ce défaut ne touche pas le chiffrement lui-même,
> mais l'affichage d'un envoi chiffré : il a sa place ici.

### Le symptôme

Une fois l'isolat réparé, la photo chiffrée s'affiche tout de suite chez
l'expéditeur. Le PDF, lui, n'apparaît pas du tout : ni bulle d'attente, ni
message. Il faut sortir de la conversation et y revenir pour le voir.

### Ce qui distingue le PDF de la photo

| | Photo | PDF |
|---|---|---|
| Choisie dans | la galerie **d'Alanya** | le sélecteur de fichiers **d'Android** |
| Alanya passe en arrière-plan | non | **oui** |

Au retour d'arrière-plan, la connexion temps réel (WebSocket) peut être
coupée. Tant qu'elle l'est, l'écran se rabat sur un relais, `_poll`, qui
toutes les 3 secondes **remplace toute la liste affichée** par la page que
rend le serveur.

### La chaîne du défaut

1. L'envoi chiffré pose une **bulle d'attente**, identifiée `tmp-…`. Elle
   n'existe que sur le téléphone.
2. `_poll` remplace la liste par celle du serveur, qui ne connaît pas
   `tmp-…` : **la bulle disparaît**.
3. L'envoi se termine et cherche `tmp-…` pour la remplacer par le vrai
   message. Il ne la trouve pas : **le message n'est ajouté nulle part**.
4. En rouvrant le fil, le message est relu depuis le cache local, où l'envoi
   l'avait bien rangé : il apparaît.

### Pourquoi les envois ordinaires n'ont pas ce défaut

Un envoi non chiffré passe par `EnvoiMediaStore`, un magasin global. À chaque
reconstruction, l'écran **rebâtit** les bulles d'attente depuis ce magasin :
même effacées par `_poll`, elles reviennent.

Un envoi chiffré n'y passe **volontairement pas** : la file hors ligne du
magasin renverrait le fichier **en clair** au retour du réseau (chapitre 25).
Il lui manquait donc cette protection.

### Le correctif

Deux fonctions pures, dans `lib/features/chat/envois_chiffres_fil.dart` :

| Fonction | Rôle |
|---|---|
| `garderEnvoisEnCours` | `_poll` garde les bulles des envois chiffrés encore en cours |
| `remplacerEnvoiChiffre` | le message est **ajouté** même si sa bulle d'attente a disparu |

`remplacerEnvoiChiffre` retire aussi la version du serveur si elle est arrivée
d'abord. Cette version n'a pas le **descripteur** (clé, nom, aperçu) : gardée,
elle afficherait « indisponible sur cet appareil ».

### Ce qui a été prouvé, et ce qui ne l'a pas été

- Prouvé par `test/envois_chiffres_fil_test.dart` : la bulle survit au
  relais, et le message est ajouté même quand la bulle a disparu.
- La bulle d'un PDF chiffré a été rendue en test : elle s'affiche. Le défaut
  n'était donc pas dans le dessin.
- **Non prouvé sur appareil** : sans journal du téléphone, la coupure du
  WebSocket au retour du sélecteur est une **déduction**, cohérente avec tous
  les indices (la photo marche, le PDF non, le fil rouvert montre tout).

### À retenir

- Une donnée qui n'existe **que sur l'appareil** (bulle d'attente, brouillon)
  doit survivre à tout remplacement par la version du serveur.
- « Remplacer X par Y » doit dire ce qui se passe **quand X n'est plus là**.
  Ici, la réponse implicite était « rien », et c'était le défaut.
- Une prédiction à vérifier : une photo prise avec **l'appareil photo**, qui
  est aussi une autre application, devait avoir le même défaut.
