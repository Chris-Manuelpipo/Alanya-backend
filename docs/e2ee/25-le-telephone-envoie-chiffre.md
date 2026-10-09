# Chapitre 25 — Le téléphone envoie chiffré

> **Où nous en sommes.** 03/10/2026. Le web sait lire (chapitre 23) et
> envoyer (chapitre 24) un média chiffré. Ce chapitre couvre le **lot C** :
> l'envoi depuis le **téléphone** — photos, vidéos, documents, vocal, et la vue
> unique chiffrée.
>
> Mobile : le commit du lot C. Serveur et web : inchangés.

---

## 1. Même chemin que le web, mêmes raisons

`EnvoiMediaChiffre.envoyer` (`lib/services/e2ee/e2ee_media_envoi.dart`) suit
pas à pas `envoyerMediaChiffre` du web : aperçu, chiffrement, téléversement
marqué `chiffre=1`, ligne du message, enveloppes, puis ma copie (cache,
archive, clair du fichier). Deux clients qui chiffrent dans un ordre différent
finiraient par produire des messages différents.

Deux différences propres au téléphone :

- **le chiffrement tourne dans un isolat** (`Isolate.run`). AES-GCM en Dart
  pur sur une vidéo de 50 Mo prend plusieurs secondes : sur le fil de l'écran,
  l'application semblerait gelée ;
- **les aperçus viennent des greffons déjà présents** : `video_thumbnail` pour
  la vidéo, `pdfx` pour le PDF, le décodeur d'images de Flutter pour la photo.

## 2. Un aperçu en PNG, et pourquoi c'est sans conséquence

Le web écrit l'aperçu d'une photo en JPEG. Flutter, lui, ne sait encoder que du
PNG sans dépendance nouvelle — et chaque dépendance se paie sur trois chaînes
d'intégration. Une mini-image de 32 px pèse ~2 Ko en PNG : la différence ne
compte pas. Le descripteur ne nomme d'ailleurs pas le format ; un JPEG commence
par `/9j/` en base64, un PNG par `iVBOR`, et un navigateur comme Flutter les
reconnaissent tous deux à leurs premiers octets.

## 3. Une seule fonction pour les enveloppes

L'envoi d'un texte construisait ses enveloppes dans sa propre boucle :
correspondant, puis mes autres appareils. L'envoi d'un média en avait besoin à
l'identique. Plutôt que de copier la boucle — et de voir un jour les deux
copies diverger —, elle est sortie dans `_enveloppesPour`, que les deux
utilisent.

⚠️ **Mais l'ordre diffère.** Le texte chiffre AVANT de créer la ligne du
message ; le média APRÈS, parce que la charge v2 porte l'identifiant du
message. Ce n'est pas une incohérence : le texte passera à la charge v2 au lot
D, et prendra alors le même ordre.

Cette modification touchait le chemin du texte : le banc qui fait envoyer un
texte par le vrai code du mobile au web (`e2ee-mobile-web.mjs`) a été relancé,
et reste vert.

## 4. La vue unique chiffrée

Une vue unique (chapitre de la vue unique) peut désormais être chiffrée. Son
visionneur savait télécharger un fichier en clair ; il sait maintenant le
**déchiffrer en mémoire** :

- la photo, dans la mémoire seule — jamais dans le cache des médias, qui la
  garderait ;
- la vidéo, dans un **fichier temporaire effacé à la fermeture** — le lecteur
  vidéo ne lit pas des octets ;
- le vocal, depuis les octets directement.

Et la copie de l'expéditeur ne garde pas le clair : une vue unique ne laisse
rien derrière elle, pas même chez celui qui l'envoie.

**Le défaut trouvé en chemin.** La bulle d'une vue unique déduisait le genre
(photo, vidéo, vocal) du type du fichier rendu par le serveur. Chiffré, ce type
est « application/octet-stream » : toutes les vues uniques chiffrées seraient
devenues des « Photo ». Le vrai type vient désormais du descripteur.

## 5. Ce qui a été prouvé, et ce qui ne l'a pas été

**Prouvé, par le vrai code contre le vrai serveur :**

- `e2ee-media-mobile-envoi.mjs` : le code du téléphone chiffre une photo, la
  téléverse, écrit la ligne et les enveloppes ; un vrai navigateur l'affiche
  déchiffrée, à sa taille, avec sa légende ;
- `e2ee-media-mobile.mjs` (chapitre 23) : l'inverse, toujours vert ;
- la suite des tests mobiles, et le banc du texte du mobile au web.

**Pas prouvé automatiquement** : les aperçus du téléphone (greffons natifs,
qui ne tournent que sur un appareil) et le geste complet depuis l'écran. Ils
restent à vérifier sur un vrai téléphone.

## 6. Le défaut trouvé sur le téléphone : la grille qui tournait sans fin

**Le symptôme.** Sur le téléphone, des photos chiffrées envoyées ensemble
montraient leur aperçu flou et un chargement qui ne finissait jamais — alors
que le web les affichait.

**La cause.** Des photos envoyées à la suite se regroupent en GRILLE. La bulle
d'un message seul savait déchiffrer ; la grille, elle, était l'ancienne grille
des médias en clair : elle téléchargeait le fichier du serveur et tentait d'en
faire une image. Ce fichier est chiffré : le décodeur échouait (« Failed to
decode image ») et la case restait en attente.

**La correction.** Une grille chiffrée se dessine avec des tuiles qui
déchiffrent chacune la leur (`TuileMediaChiffre`), dans la même disposition
que la grille ordinaire.

**Et la grille du web, reprise au passage :**

- **la légende sous la grille.** Un lot accepte désormais UN message légendé
  (comme `groupMediaRuns` du web) ; deux légendes, et le lot ne se forme pas,
  plutôt que d'en perdre une ;
- **quatre tuiles au plus**, « +N » sur la quatrième, qui ouvre le lot entier.

> ⚠️ **Ce n'était que la moitié de l'histoire.** Même corrigée, la grille
> continuait de tourner : la vraie cause était un Future qui s'attendait
> lui-même. Voir le chapitre 26, section 7.

**La leçon.** Le chiffrement avait été branché là où un média s'affiche… seul.
Chaque endroit qui affiche un média — bulle, grille, réponse citée, galerie —
doit être passé en revue : un seul oubli, et c'est le fichier chiffré qu'on
montre.

## 7. À retenir

- Deux clients, **un seul ordre** d'envoi.
- Le calcul lourd hors du fil de l'écran.
- Une boucle partagée plutôt que deux copies — et le banc de l'ancien usage
  relancé après l'avoir partagée.
- Un média éphémère se déchiffre **là où il ne laisse pas de trace**.
- Chiffrer un média, c'est revoir **tous** les endroits qui l'affichent.
