# Chapitre 24 — Envoyer un média chiffré

> **Où nous en sommes.** 03/10/2026. Le chapitre 23 a appris aux deux clients à
> **lire** un média chiffré. Ce chapitre couvre le **lot B** : l'**envoi**
> depuis le web — le trombone, l'écran de confirmation, le vocal — avec la
> fabrication des aperçus.
>
> Web : le commit du lot B. Le serveur n'a pas changé.

---

## 1. L'ordre de l'envoi, et pourquoi il est celui-là

`envoyerMediaChiffre` (`src/services/e2ee-media-envoi.ts`) enchaîne six étapes.
L'ordre n'est pas libre :

1. **l'aperçu**, pendant que le fichier est encore en clair — après le
   chiffrement, il serait trop tard ;
2. **le chiffrement** du fichier, avec une clé neuve ;
3. **le téléversement** du fichier chiffré, marqué `chiffre=1` : le serveur
   n'en garde ni le nom ni le type ;
4. **la ligne du message**, sans contenu. C'est elle qui donne l'identifiant
   que la charge v2 doit porter (chapitre 23, § 4) — l'enveloppe ne peut donc
   être écrite qu'**après** ;
5. **les enveloppes**, pour chaque appareil du correspondant et pour mes
   autres appareils ;
6. **ma copie** : cache local, clair du fichier, archive. On ne s'envoie pas
   d'enveloppe à soi-même : ce sont les seuls endroits où ma copie de la clé
   existe.

## 2. Les aperçus, fabriqués dans le navigateur

`src/services/e2ee-apercus.ts`, une fonction par genre :

| genre | comment | taille |
|---|---|---|
| photo | `createImageBitmap`, réduite à 32 px | ~1-3 Ko |
| vidéo | un `<video>` hors écran, avance à 0,1 s, image copiée sur une toile | ~320 px |
| PDF | pdf.js, première page | ~160 px, + nombre de pages |
| vocal | la durée seule | — |

**Le plafond.** Une enveloppe ne dépasse pas 64 Ko côté serveur, et la charge y
est encore chiffrée par Signal puis encodée en base64. L'aperçu est donc
plafonné : trop gros, il est refait plus petit ; encore trop gros, abandonné.
Un média sans aperçu reste envoyable — un média trop lourd pour son enveloppe
ne le serait pas.

**Ne jamais lever.** Un format que le navigateur ne sait pas lire (une vidéo
exotique, un PDF abîmé) ne doit pas empêcher l'envoi : la fonction rend alors
un aperçu vide, après une garde de 8 secondes pour la vidéo.

## 3. Un média par message, une grille à l'écran

Décision du user : dans un fil chiffré, cinq photos partent en **cinq
messages**. Elles sont regroupées à l'affichage, comme avant. Il a fallu pour
cela que la grille sache **déchiffrer ses tuiles** (`TuileChiffree`) et que son
ouverture plein écran passe par les copies déchiffrées — la galerie ne sait
lire que des adresses ; on lui donne des adresses locales (`blob:`), jamais le
fichier du serveur.

## 4. La file hors ligne : le piège évité

L'envoi ordinaire d'un média, en cas de coupure réseau, le range dans une file
qui repart au retour du réseau. Cette file renvoie **par le chemin ordinaire** —
en clair. Le chemin chiffré n'y passe donc pas : une coupure affiche une
erreur, et l'utilisateur renvoie. Faire mieux (une file chiffrée) est noté pour
plus tard ; faire pire — un fichier qui part en clair des heures après, sans
que personne ne le voie — n'était pas acceptable.

## 5. Les erreurs rencontrées

**① Le banc était vert, et l'écran était faux.** Les dix-sept contrôles
passaient ; la capture d'écran montrait deux défauts que rien ne vérifiait :

- un PDF chiffré affichait **deux cartes** : la nôtre, et la carte ordinaire
  des fichiers, avec « chiffre.bin » et un bouton qui aurait téléchargé le
  fichier illisible. La carte ordinaire ne regardait que le type du message,
  pas la marque « chiffré » ;
- la bannière « chiffré à partir d'ici » tombait **après** la grille des
  premières photos : elle cherchait le premier *message* chiffré, et une grille
  n'est pas un message, c'est un *album*.

Les deux sont corrigés, et le banc vérifie désormais l'un et l'autre. La leçon
vaut au-delà de ce lot : **un banc ne voit que ce qu'on lui demande de
regarder** ; la capture d'écran, elle, montre tout.

**② L'avertissement devenu faux.** Le 21/09, le menu des pièces jointes
prévenait : « dans ce fil, les pièces jointes ne sont pas chiffrées ». C'était
vrai, et le dire était un devoir. Le jour où elles le sont, le même message
devient un mensonge. Il est retiré dans le même commit que le chiffrement —
pas plus tard.

## 6. Ce qui reste

- **Le mobile ne sait pas encore envoyer** : lot C.
- **Ordre de déploiement** : un téléphone resté sur l'ancienne application ne
  sait pas lire la charge v2. Le web du lot B ne doit donc être mis en ligne
  qu'une fois le nouvel APK (lot A) installé.
- La règle CORS de Backblaze pour le téléchargement direct en production.

## 7. À retenir

- L'aperçu se fabrique **avant** le chiffrement, l'enveloppe **après** la
  ligne du message : l'ordre découle de ce que chaque étape consomme.
- Un aperçu est **plafonné** et **facultatif** : jamais il ne bloque un envoi.
- Une file d'attente qui contourne le chiffrement est pire qu'une erreur.
- Regarder l'écran, pas seulement le banc.
