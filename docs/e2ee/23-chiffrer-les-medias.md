# Chapitre 23 — Chiffrer les médias

> **Où nous en sommes.** 03/10/2026. Jusqu'ici, dans une conversation chiffrée,
> seuls les **textes** l'étaient : une photo, une vidéo, un vocal partaient en
> clair, et le serveur pouvait les ouvrir. Ce chapitre ouvre la campagne des
> médias. Il en couvre le **lot A** : apprendre aux deux clients à **lire** un
> média chiffré, avant que quiconque n'en envoie.
>
> Web, mobile et serveur : les commits du lot A.

---

## 1. Le problème : le texte tient dans une enveloppe, une vidéo non

Un texte chiffré voyage dans une **enveloppe Signal**, une par appareil
destinataire. Une enveloppe est petite — 64 Ko au plus côté serveur
(`CORPS_MAX`) — et elle est **purgée** dès qu'elle est relevée.

Une vidéo pèse jusqu'à 50 Mo, et doit rester disponible : pour le second
téléphone qui la relira plus tard, et pour le **nouveau** téléphone après un
changement d'appareil — l'objectif fixé par le user.

On ne peut donc pas mettre le fichier dans l'enveloppe. On fait ce que font
WhatsApp et Signal :

1. l'appareil tire une **clé au hasard** pour ce fichier, et le chiffre ;
2. le fichier chiffré part sur le stockage (Backblaze) : **illisible** ;
3. la **clé** part dans l'enveloppe Signal, avec le reste du message.

Le fichier n'est chiffré **qu'une fois**, quel que soit le nombre
d'appareils ; seule sa clé est chiffrée pour chacun.

## 2. Telegram fait autrement — et c'est instructif

Telegram a deux régimes. Par défaut (« cloud »), **pas de bout en bout** : il
peut lire les fichiers, et c'est ce qui lui permet vignettes, lecture en flux
et historique sur tous les appareils. En « conversation secrète », il fait le
même geste que nous (clé par fichier, transmise dans le message chiffré) mais
l'attache à **un seul appareil** : ni synchronisation, ni récupération sur un
nouveau téléphone.

Notre exigence est plus forte que les deux : le chiffrement **et** le
changement de téléphone. C'est ce qui rend l'archive chiffrée indispensable
(§ 6).

Autre écart : Telegram chiffre ses fichiers en **AES-IGE**, un mode qui
n'authentifie pas le contenu, et que les navigateurs ne proposent pas. Nous
prenons **AES-GCM**, qui authentifie et que WebCrypto offre nativement.

## 3. Le fichier chiffré : le format AGB1

Le fichier est découpé en **blocs de 64 Kio**, chacun chiffré en AES-256-GCM.

| octets du nonce (12) | contenu |
|---|---|
| 0 à 6 | zéro |
| 7 à 10 | numéro du bloc (gros-boutiste) |
| 11 | 1 pour le **dernier** bloc, 0 sinon |

Pourquoi des blocs et pas le fichier d'un coup : une barre de progression
réelle, une mémoire bornée sur un téléphone, et la porte ouverte à la lecture
en flux d'une vidéo plus tard.

**Mais chiffrer bloc par bloc ouvre trois attaques** : intervertir deux blocs,
en retirer un, couper la fin. Chacun, pris seul, se déchiffrerait. La parade
est la construction **STREAM** (Hoang, Reyhanitabar, Rogaway, Vizár, 2015) :

- le **numéro** du bloc est dans le nonce → un bloc déplacé ne passe plus ;
- le drapeau **dernier** est dans le nonce → un fichier coupé net à une
  frontière de bloc est refusé, car l'avant-dernier bloc n'a pas été chiffré
  « comme dernier ».

⚠️ **Un nonce déterministe n'est sûr que parce que la clé est neuve.** Deux
fichiers ne partagent jamais une clé, donc jamais une paire (clé, nonce). Le
code tire la clé lui-même et n'en accepte aucune de l'appelant — sauf le
vecteur de test (§ 7).

## 4. La charge de l'enveloppe, version 2

L'enveloppe portait un texte nu. Elle porte désormais, au besoin, un objet :

```
"\u0000A2" + {"v":2, "id":"<identifiant du message>", "texte":"…",
              "media":{ id, cle, empreinte, taille, mime, nom?,
                        largeur?, hauteur?, dureeMs?, pages?, apercu? }}
```

Trois décisions :

- **Le préfixe commence par un caractère nul**, impossible à taper. Un
  utilisateur qui écrirait littéralement `{"v":2,…}` envoie toujours un texte :
  la reconnaissance ne peut pas être trompée par ce qu'on écrit. Un test le
  vérifie.
- **L'identifiant du message est DANS le chiffré** — c'est le *protocole v2*
  annoncé au chapitre 21. Le serveur rattache chaque enveloppe à un message ;
  s'il la rattachait à un autre, l'identifiant chiffré ne correspondrait plus,
  et l'enveloppe est refusée. Avant, seule la règle « même expéditeur, même
  fil » limitait ce qu'il pouvait faire.
- **Le descripteur est vérifié champ par champ** : une clé qui ne fait pas 32
  octets, une empreinte tronquée, et toute la charge est refusée. On ne
  devine jamais une valeur par défaut pour une clé.

Les **anciens messages** (texte nu) passent tels quels : rien ne change pour
l'historique.

## 5. Les aperçus : c'est l'expéditeur qui les fabrique

Aujourd'hui, les aperçus lisent le fichier **sur le serveur** : la vignette
d'une vidéo est extraite du flux, la première page d'un PDF est rendue à
partir du fichier. Chiffré, ce fichier ne dit plus rien.

L'expéditeur, lui, a le fichier en clair. C'est donc lui qui fabrique l'aperçu,
et l'aperçu voyage **dans l'enveloppe**, chiffré avec la clé :

| média | dans l'enveloppe | à l'écran |
|---|---|---|
| photo | mini-image floutée (~3 Ko) + dimensions | bulle à la bonne taille tout de suite |
| vidéo | première image (~15 Ko) + durée | vignette sans rien télécharger |
| vocal | durée | bulle complète |
| document | première page + vrai nom + taille + pages | carte complète |

Les **dimensions** comptent autant que l'image : la bulle prend sa taille
d'emblée, et le fil ne saute pas quand la photo nette arrive.

## 6. Ranger la clé, pour le changement de téléphone

Une enveloppe relevée est acquittée, puis purgée : **la clé du média n'existe
plus nulle part ailleurs** que là où on l'a rangée. Elle va donc :

- dans le **cache local** (IndexedDB sur le web, colonne `e2ee_media_json` du
  cache SQLite sur le mobile, migration v8) ;
- dans l'**archive chiffrée**, champ `media` — c'est lui qui permet au nouveau
  téléphone de rouvrir la photo : la clé revient de l'archive, le fichier
  revient de Backblaze.

## 7. Prouver que les deux clients sont jumeaux

Le chiffrement existe en deux langages : TypeScript (web) et Dart (mobile). Un
octet de différence, et un média envoyé d'un côté ne s'ouvre plus de l'autre.

**Le vecteur de test.** Le web chiffre des contenus connus avec une clé fixe,
aux frontières (vide, moins d'un bloc, pile deux blocs, deux blocs et demi), et
écrit le résultat dans le dépôt mobile
(`STAGE-WEB/scripts/e2ee-media-vecteur.mjs` →
`alanya/test/donnees/vecteur_media.json`). Le test Dart exige **les mêmes
octets**, et sait déchiffrer ceux du web.

**Le test d'attaque.** Sur les deux clients : blocs inversés, dernier bloc
retiré, un bit changé, mauvaise clé, mauvaise empreinte, mauvaise taille,
charge rattachée à un autre message. Tous refusés.

**Le banc réel, dans les deux sens.**

- `scripts/e2ee-media-lecture.mjs` : Alice (web) envoie une photo, Bob (web) la
  voit déchiffrée, à 320 px, avec sa légende ; une seconde photo dont le
  fichier ne correspond pas à l'empreinte est **refusée, et c'est dit** ;
  après rechargement, la photo se rouvre depuis le cache.
- `scripts/e2ee-media-mobile.mjs` : Alice (web) envoie, et le **vrai code du
  mobile** relève, télécharge le fichier illisible du serveur et le déchiffre
  en un PNG valide.

## 8. Les erreurs rencontrées

**① Je me suis trompé sur l'empreinte, et je l'ai dit au user.** J'avais
affirmé que sans empreinte, le serveur pourrait substituer le fichier d'un
message à celui d'un autre. C'est **faux avec GCM** : chaque fichier a sa clé,
un fichier étranger ne se déchiffre pas. L'empreinte reste — filet contre nos
propres bugs, vérification du cache, diagnostic clair — mais comme protection
de secours. Ce qui compte : la corriger avant que le plan ne repose dessus.

**② Deux fabriques d'entrée de cache, toutes deux en « TEXT ».** La relève et la
restauration écrivaient chacune leur propre entrée, avec `type: "TEXT"` en
dur. Ajouter les médias à l'une aurait laissé l'autre aveugle : une photo
relevée en direct se serait affichée, la même restaurée sur un autre
ordinateur non. Une fabrique unique (`e2ee-entree-cache.ts`) sert désormais les
deux.

**③ Le cache aurait perdu la clé au premier rafraîchissement.** La liste du
serveur réécrit chaque message — sans descripteur, puisqu'il ne l'a jamais
eu. La protection existait pour le **texte** (`preserveLeTexte` sur le web,
`planRemplacement` sur le mobile) ; il a fallu l'étendre au descripteur, sur
les deux clients et sur chacun de leurs chemins d'écriture.

**④ L'archive sautait les messages sans texte.** `archiver` ignorait tout
message dont le texte était vide — une photo sans légende n'aurait jamais été
archivée, donc jamais rouvrable sur un nouveau téléphone. Le test devient « ni
texte ni média ».

**⑤ La politique de sécurité du site.** Le web télécharge le fichier chiffré
**directement** depuis Backblaze (décision du user), donc par `fetch` : il a
fallu y autoriser nos deux seaux (`connect-src`). Cette ligne est une barrière —
elle dit où un script hostile pourrait envoyer ce qu'il aurait lu. L'ouvrir à
**nos** deux seaux ne lui donne aucun endroit où déposer : on n'y écrit pas
sans nos clés, et leurs journaux ne sont lisibles que par nous. Si le direct
échoue, le web repasse par le serveur (`?flux=1`) — ce qui ne révèle rien, le
fichier étant chiffré.

## 9. Ce qui n'est pas encore fait

- **L'envoi** : lot B (web), lot C (mobile). Le lot A fabrique déjà ce que les
  boutons produiront, mais seul le banc s'en sert.
- La **règle CORS** des seaux Backblaze, nécessaire au téléchargement direct en
  production. Sans elle, le repli par le serveur prend le relais (8 Mo au plus).
- Le regroupement en **grille** des photos chiffrées envoyées à la suite.
- Une **vue unique chiffrée** : son visionneur ne sait pas encore déchiffrer.
- Le serveur accepte encore un média **en clair** dans un fil chiffré : il le
  refusera au lot D, quand tous les clients sauront envoyer chiffré.

## 10. À retenir

- Le fichier est chiffré **une fois** ; sa **clé** voyage par Signal, une fois
  par appareil.
- Chiffrer par blocs impose de **protéger l'ordre et la fin** : numéro et
  drapeau « dernier » dans le nonce.
- Ce que le serveur ne peut plus faire — vignettes, aperçus — c'est
  **l'expéditeur** qui le fait, et l'envoie chiffré.
- Une clé consommée n'existe plus que là où on l'a rangée : **cache et
  archive**, sur tous les chemins d'écriture.
- Deux implémentations d'un même chiffrement se tiennent par un **vecteur de
  test** commun, pas par la relecture.
