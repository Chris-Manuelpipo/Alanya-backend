# Chapitre 22 — Le coffre et son propriétaire

> **Où nous en sommes.** 29/09/2026. Lot A, le dernier de la campagne. Le
> coffre local contient ce qu'il y a de plus précieux : l'**identité privée**
> de l'appareil, ses **sessions** et la **clé de l'archive**. La question du
> lot : *à qui appartient-il, et quand disparaît-il ?* Les deux clients
> répondaient mal, chacun à sa façon.
>
> Web et mobile : les commits du lot A.

---

## 1. Web : le compte suivant héritait de l'identité du précédent

Le coffre du navigateur (IndexedDB `alanya-coffre-e2ee`) n'était rattaché à
**aucun compte**. Une seule sortie le vidait : la déconnexion simple.

Or on quitte une session de bien d'autres façons :

| sortie | coffre vidé ? |
|---|---|
| « Se déconnecter » | ✅ |
| « Déconnecter partout » | ❌ |
| « Supprimer le compte » | ❌ |
| session expirée, onglet fermé | ❌ |

Dans les trois derniers cas, le compte **suivant** qui se connectait dans ce
navigateur trouvait un coffre plein. `preparerCetAppareil` y lisait une
identité, et la **publiait comme la sienne**. Bob chiffrait et déchiffrait avec
la clé privée d'Alice, héritait de ses sessions et archivait avec sa clé.

### Le correctif : le verrou de propriétaire, qui existait déjà

Le web avait déjà un mécanisme pour ce problème exact, mais pour les caches de
messages : `claimLocalCaches` retient à qui appartiennent les caches, et les
purge dès qu'un **autre** compte prend la main. Le coffre n'y avait simplement
jamais été ajouté.

`purgeLocalAccountData` vide désormais aussi le coffre, la clé d'archive en
mémoire et les clés `alanya.e2ee.*`. Elle est appelée :

- par **toutes** les sorties de session (`leaveSessionLocally`) ;
- par le verrou de propriétaire, quand le compte **change** — le seul chemin
  qui couvre l'expiration et l'onglet fermé.

> ⚠️ **La même personne qui se reconnecte garde son coffre.** Le verrou ne
> purge que si le propriétaire change. Une simple expiration de session ne
> déclenche donc pas d'alerte « clé changée » chez ses correspondants.

« Déconnecter partout » retire en plus l'identité côté serveur, comme la
déconnexion simple.

### L'erreur trouvée en chemin

Le premier correctif ne suffisait pas : le banc restait rouge. `viderCoffre` ne
vidait la base **que si elle avait déjà été ouverte dans la page**. Après le
rechargement vers la page de connexion — exactement le moment du changement de
compte —, elle ne l'était pas encore. Le vidage ne faisait rien, en silence.

L'autre étape du banc passait, parce que *sa* page avait ouvert le coffre. **Deux
chemins pour la même fonction, et un seul testé par hasard.**

---

## 2. Mobile : une fonction que personne n'appelait

`CoffreE2ee.oublier()` existait, bien écrite, commentée : « Efface tout — à la
déconnexion ». L'avertissement montré avant la déconnexion le disait même à
l'utilisateur. **Elle n'avait aucun appelant.**

> 🔴 **Le motif ⑤ du registre, une fois de plus** : le texte affirmait plus que
> le code. Un commentaire qui décrit une intention comme un fait fait passer
> la relecture suivante à côté.

Quatre écrans appelaient `AuthController.logout()` directement : les réglages,
le menu de l'accueil, la suppression de compte, la dissociation. Aucun ne vidait
le coffre. Ils passent désormais tous par un seul chemin, `seDeconnecter` :
identité retirée du serveur, coffre vidé, puis session fermée.

### Le défaut caché sous le défaut

En éprouvant `oublier()`, le test a échoué : après l'appel, le coffre disait
encore « publié ». La boucle parcourait la table rendue par `readAll` **tout en
supprimant ses entrées**. Si la table est vivante (c'est le cas du stockage
simulé des tests), la boucle casse à la première suppression, et le coffre reste
à moitié plein.

Sur un vrai téléphone, `readAll` rend une copie, et la boucle passe. Mais rien ne
le garantit, et deux autres fonctions avaient le même motif. Elles parcourent
toutes désormais une **copie** des clés.

> ⚠️ **Un test qui échoue pour une raison inattendue est un cadeau.** On
> voulait prouver un branchement ; on a trouvé une boucle fragile.

---

## 3. Mobile : l'appareil que le serveur avait oublié

Un appareil peut disparaître du serveur sans que son coffre le sache :
dissociation, déconnexion à distance, balayage des trente jours de silence. Le
coffre gardait « publié » : au démarrage, rien ne republiait. Et le
réapprovisionnement, qui interroge le serveur, ne faisait **rien** pour un
appareil absent de la liste.

Les correspondants obtenaient « Aucun appareil chiffré ». Le téléphone était
muet, et rien ne le signalait à son propriétaire.

Désormais, un appareil absent de la liste **se republie**, avec la **même**
identité : aucune alerte « clé changée » chez les autres.

---

## 4. Ce qui n'a pas été fait

- **La sauvegarde Android** (`android:allowBackup`) n'est pas désactivée :
  l'historique en clair peut partir dans la sauvegarde Google Drive. Le stockage
  local en clair est un choix assumé ; son départ **hors** de l'appareil est une
  autre question, soumise au user.
- **Le banc `e2ee-banc.mjs`** reste à adapter au lot B (il dépose dans un fil
  qu'il n'active pas) ; sa lecture m'a été refusée.

---

## 5. À retenir

1. **Un secret appartient à quelqu'un.** S'il ne sait pas à qui, il finit chez
   le mauvais.
2. **Chercher le mécanisme qui existe déjà.** Le verrou de propriétaire était
   là, pour les caches ; il suffisait d'y ranger le coffre.
3. **Toutes les sorties, pas la plus visible.** La déconnexion simple était
   correcte ; les trois autres portes ne l'étaient pas.
4. **Une fonction sans appelant n'existe pas.** Chercher qui l'appelle est la
   première vérification, avant de lire ce qu'elle fait.
5. **Ne jamais modifier une table qu'on parcourt.** Copier d'abord.
