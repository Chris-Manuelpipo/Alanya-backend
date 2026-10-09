# Chapitre 7 — Trois serrures sur une porte

> **Où nous en sommes.** Le chiffrement tient, les clés se vérifient, le serveur
> oublie ce qu'il ne peut plus lire. Reste le prix à payer pour tout cela :
> **changer d'appareil, c'est perdre son historique.**
>
> Ce chapitre construit l'archive chiffrée. Il raconte aussi sept erreurs, dont
> une signalée par l'utilisateur lui-même — et qui n'était pas un bogue.
>
> Lot 3 du plan. Branche `feat/e2ee`.

---

## 1. La contradiction qu'il faut regarder en face

Au chapitre 6, nous avons établi qu'une enveloppe acquittée est
**définitivement indéchiffrable**. Le ratchet a avancé, la clé est détruite.

C'est une excellente propriété. C'est aussi un problème.

> Alice utilise l'application depuis deux ans. Son téléphone tombe dans l'eau.
> Elle en achète un neuf, se connecte, et trouve **toutes ses conversations
> vides**.

Et ce n'est pas un défaut : c'est le fonctionnement correct. Le serveur n'a rien
gardé qu'il puisse rendre. Les enveloppes sont acquittées, donc mortes.

Il faut donc nommer la tension :

> 🔴 **La confidentialité persistante et la sauvegarde durable sont
> contradictoires.**
>
> L'une détruit volontairement la possibilité de relire. L'autre la préserve
> volontairement.

On ne peut pas demander à la même boîte de faire les deux. **Il en faut une
seconde**, séparée, avec ses propres clés — et sous le contrôle de
l'utilisateur, pas le nôtre.

### « Mais les enveloppes gardent déjà les messages chiffrés ? »

C'est la question qu'on pose immanquablement, et elle est juste. Voici pourquoi
elles ne peuvent pas servir d'archive :

| | enveloppe | bloc d'archive |
|---|---|---|
| destinataire | **un appareil précis** | le **compte** |
| clé | dérivée du ratchet | la clé maîtresse |
| après lecture | **illisible à jamais** | relisible |
| durée | 30 jours | tant qu'on veut |

Une enveloppe est adressée à *un appareil*. Un navigateur neuf a une autre
identité et aucune session : lui resservir de vieilles enveloppes ne lui
apprendrait rien. Et même si on les gardait cent ans, **le ratchet a détruit la
clé**.

> **L'enveloppe est un transport. Le bloc est un rangement.** Elles résolvent
> des problèmes opposés.

---

## 2. L'idée qui rend tout possible

Voici la décision centrale de ce lot. Elle est simple, et tout en découle.

**La clé qui chiffre l'archive est tirée au sort. Elle n'est dérivée de rien.**

```
                       ┌──▶ trousseau de l'appareil
                       │
   clé maîtresse ──────┼──▶ mot de passe du compte
    (aléatoire)        │
                       └──▶ clé de récupération
```

On ne chiffre l'archive qu'**une fois**, avec cette clé. Puis on **enveloppe la
clé** autant de fois qu'on veut, avec autant de secrets différents qu'on veut.

Trois serrures sur la même porte. Il suffit d'une seule pour entrer.

### Pourquoi pas dériver la clé du mot de passe ?

C'est l'approche naïve, et voici ce qu'elle coûte :

> ⚠️ Si la clé était dérivée du mot de passe, **en changer obligerait à
> rechiffrer toute l'archive.** Cent mégaoctets à relire, déchiffrer, rechiffrer
> et renvoyer — sur un téléphone, en 4G.

Avec l'indirection, changer de mot de passe **ré-enveloppe 32 octets**. Quelques
millisecondes.

Et surtout : ajouter une serrure des mois plus tard donne accès à **tout
l'historique déjà écrit**, sans rien rechiffrer. C'est ce que le banc vérifie :

```
  ✓ la nouvelle serrure ouvre les blocs écrits AVANT elle
```

---

## 3. Le détail que presque tout le monde rate

Voici le point le plus subtil du lot, et il concerne l'étirement de clé.

On dit souvent : « pour dériver une clé d'un mot de passe, faites beaucoup
d'itérations ». C'est vrai. Mais **pourquoi** ?

> L'étirement compense un **manque d'entropie**.

Un mot de passe humain vaut peut-être 30 bits. Il se devine. On rend donc chaque
essai coûteux, pour que deviner prenne des siècles.

Maintenant, regardons nos trois secrets :

| secret | entropie | se devine ? |
|---|---|---|
| mot de passe du compte | ~30 bits | **oui** |
| secret du trousseau | 256 bits tirés au sort | non |
| clé de récupération | 256 bits tirés au sort | non |

Les deux derniers **ne se devinent pas**. Les étirer ne protège de *rien*. Cela
ne fait que coûter une seconde à quelqu'un qui déverrouille son téléphone.

D'où des réglages qui diffèrent **par serrure** :

```js
const REGLAGES = {
  // Argon2id : 64 Mio par essai. ~750 ms mesurés dans Chrome.
  motdepasse: { algo: "argon2id",
                parametres: { memoireKio: 65536, passes: 3, parallelisme: 1 } },

  // Une seule itération, et ce n'est pas une négligence.
  trousseau:    { algo: "pbkdf2-sha256", parametres: { iterations: 1 } },
  recuperation: { algo: "pbkdf2-sha256", parametres: { iterations: 1 } },
}
```

> ⚠️ **Appliquer le réglage fort partout est l'erreur la plus fréquente.** On
> paie le prix d'une protection inutile, on croit avoir mieux fait — et cela
> pousse à réduire là où ça compte vraiment.

### Pourquoi Argon2id et non PBKDF2

Pour le seul secret qui se devine, le choix d'algorithme compte :

- **PBKDF2 se parallélise sur carte graphique** : des milliers d'essais par
  seconde sur du matériel courant.
- **Argon2id exige de la mémoire** — 64 Mio par essai — ce qu'une carte
  graphique ne peut pas multiplier à l'infini.

C'est exactement la menace que cette serrure combat : quelqu'un qui a emporté
une copie de la base et attaque hors ligne.

---

## 4. Ranger les paramètres AVEC la serrure

Petit détail, grande conséquence.

```
e2ee_serrures
  ├─ sel
  ├─ iv
  ├─ cle_enveloppee
  ├─ algo            ← "argon2id"
  └─ parametres      ← {"memoireKio":65536,"passes":3,...}
```

Pourquoi ne pas mettre ces valeurs en constante dans le code ?

> 🔴 Parce que durcir les réglages un jour rendrait **illisibles toutes les
> serrures déjà créées**. On ne saurait plus avec quoi elles ont été fabriquées.

Une constante dans le code décrit *ce qu'on fait aujourd'hui*. Une colonne en
base décrit *ce qui a été fait ce jour-là*. Pour tout ce qui doit se relire dans
dix ans, c'est la seconde qu'il faut.

---

## 5. Ce qu'on ne range PAS : un vérificateur

Tentation naturelle : ranger un haché du secret à côté de la serrure, pour dire
« mauvais mot de passe » proprement.

**Surtout pas.**

> 🔴 AES-GCM **authentifie**. Un mauvais secret fait échouer le déchiffrement, et
> c'est *le* contrôle. Ranger un vérificateur à côté offrirait une cible à
> casser hors ligne — sans même toucher à l'archive.

Le banc le vérifie de façon amusante : il liste les champs de la serrure et
s'assure qu'aucun ne permettrait de tester un secret autrement.

```js
verifie(
  "la serrure ne porte aucun haché de vérification",
  Object.keys(sMdp).sort().join(",") === "algo,cleEnveloppee,iv,parametres,sel,type",
)
```

Si quelqu'un ajoute un champ un jour, ce test rougit et pose la question.

---

## 6. La clé de récupération, telle qu'on la recopie vraiment

Douze mots. C'est le seul secours si le mot de passe est oublié.

Trois décisions viennent de l'usage réel, pas de la cryptographie :

**① Un dictionnaire sans accents ni caractères ambigus.** Elle sera recopiée à
la main, sur un carnet, peut-être par quelqu'un qui n'a pas de clavier français.

**② Une saisie sale doit passer.** Majuscules involontaires, espaces en trop,
retour à la ligne collé depuis un carnet :

```js
const saisieSale = "  CERISE   SABLE   MONTAGNE ...\n"
ouvrirArchive(normaliserCleRecuperation(saisieSale), serrure)  // ✓ ouvre
```

> ⚠️ Refuser pour cela reviendrait à **perdre l'archive pour une raison qui n'a
> rien à voir avec la sécurité**.

**③ Les mots sont numérotés à l'écran.**

```
   1 hibou      2 lampe      3 hibou
   4 brume      5 fenetre    6 tortue
```

Douze mots se recopient dans le désordre plus souvent qu'on ne le croit, et
l'erreur ne se découvre qu'au moment de s'en servir — des mois plus tard, quand
il est trop tard.

**Et l'avertissement est placé AU-DESSUS des mots.** Placé en dessous, il se lit
une fois la clé recopiée : trop tard pour changer le soin qu'on y a mis. Le banc
navigateur le vérifie **par la géométrie** :

```js
const ordre = await page.evaluate(() => {
  const a = document.querySelector(".sauv-cle-avert")
  const m = document.querySelector(".sauv-cle-mots")
  return a.getBoundingClientRect().top < m.getBoundingClientRect().top
})
```

Vérifier la présence du texte n'aurait rien prouvé. C'est sa **position** qui
fait l'effet.

---

## 7. Sept erreurs, et ce qu'elles apprennent

### ① Deviner une signature au lieu de la lire

J'ai appelé `motifRefus(user.typeCompte)` sans ouvrir le fichier. La fonction
juge une **conversation**, pas un compte — elle répond « groupe » ou « hors
périmètre » pour un fil.

TypeScript l'a attrapé. Sans lui, la route aurait renvoyé un motif absurde.

> **Le temps gagné à ne pas lire une signature se repaie avec intérêts.**

### ② Un `catch` muet, écrit par celui qui les dénonce

```js
// ❌ CE QUE J'AVAIS ÉCRIT
} catch {
  return 0
}
```

La restauration échouait, et **rien ne disait pourquoi**. « L'historique ne
revient pas » était tout ce qu'on savait.

```js
// ✅ CE QU'IL FALLAIT
} catch (e) {
  console.error("[e2ee] restauration à la connexion impossible :", e)
  return 0
}
```

Et un cas mérite son propre message : le mot de passe du **compte** et celui de
la **sauvegarde** peuvent différer, si l'un a changé sans l'autre.

### ③ Une prudence qui rendait la fonctionnalité inutilisable

J'avais écrit, très fier :

> *« La clé maîtresse reste en mémoire, pas sur le disque. La ranger reviendrait
> à poser une quatrième serrure que l'utilisateur n'a pas choisie. »*

Beau raisonnement. **Et faux en pratique** : la navigation qui suit la connexion
recharge la page. Le module repart à zéro, la clé disparaît, et l'archive se
referme aussitôt après s'être ouverte.

Le compromis réel, une fois mesuré :

> ⚠️ Le coffre local contient **déjà** les clés Signal et le cache en clair. Qui
> l'ouvre lit déjà ce que cet appareil a vu. Mais l'archive porte l'historique
> **d'avant** cet appareil : y ranger la clé élargit ce qu'une compromission
> rapporte.
>
> Ce qui le rend acceptable : le coffre est chiffré par une clé **non
> extractible**, et la déconnexion le vide.

L'alternative était de redemander le mot de passe à chaque rechargement — c'est-
à-dire de ne pas livrer la fonctionnalité.

**Une précaution qui rend une chose inutilisable n'est pas une précaution.**

### ④ Un banc qui ne se rejoue pas

Le banc navigateur nommait l'appareil « Navigateur du banc ». Le serveur refuse
deux appareils du même nom : il passait **la première fois** et échouait toutes
les suivantes — sur un délai d'attente au clic, ce qui envoie chercher un défaut
de mise en page là où il n'y a qu'un nom pris.

> **Un banc qui ne se rejoue pas est un banc qu'on cesse de lancer.**

### ⑤ Un motif de test qui attrape autre chose

```js
page.getByRole("button", { name: /Activer la sauvegarde/i })
```

Ce motif correspond aussi à « **Dés**activer la sauvegarde ». Le banc se piégeait
lui-même et **accusait le produit**.

> ⚠️ Un motif non ancré finit par attraper autre chose — surtout dans une langue
> où l'on préfixe pour nier. `/^Activer la sauvegarde$/`.

### ⑥ Reconstituer une session de l'extérieur

Pour tester l'écran, j'ai posé le jeton dans `localStorage`. L'application m'a
renvoyé sur `/login` **sans une seule erreur**.

Une session ne tient pas qu'à ce jeton : il y a le rafraîchissement, le profil,
l'état du fournisseur d'authentification. Reconstituer tout cela de l'extérieur,
c'est **réécrire la connexion et se tromper en silence**.

Le banc passe maintenant par le vrai formulaire — ce qui est aussi plus fidèle,
et éprouve au passage que la connexion marche.

### ⑦ La mesure qu'il fallait refaire dans un vrai navigateur

Les bancs tournaient sous Node, avec `fake-indexeddb` et le WebCrypto de Node.
Deux hypothèses n'y étaient **pas vérifiées** — et tout le coffre repose
dessus :

```
✓ un CryptoKey non extractible survit à IndexedDB
✓ Chrome REFUSE de l'exporter          (InvalidAccessError)
✓ et elle chiffre encore APRÈS relecture   ← le contrôle qui comptait
```

Le quatrième est celui qui importait : une clé qu'on ne peut plus **utiliser**
après relecture aurait rendu le coffre inutilisable au premier rechargement.

Et deux mesures que Node donnait fausses :

| | Node | Chrome |
|---|---|---|
| Argon2id | 412 ms | **741 ms** |
| code de sécurité | 450 ms | **108 ms** |

> Une spécification n'est pas une mesure.

Détail pratique : plutôt que de télécharger un Chromium, on pilote le **Chrome
déjà installé** (`channel: "chrome"`). On teste ce que les gens utilisent, et
c'est un gigaoctet de moins.

---

## 8. Le défaut signalé par l'utilisateur — qui n'en était pas un

> *« Je me déconnecte, je me reconnecte, et tous les messages sont vides. »*

Trois décisions **correctes** s'additionnaient :

1. la déconnexion **efface le coffre** — garder les clés privées reviendrait à
   laisser de quoi lire sur l'appareil ;
2. elle **purge le cache local** — sinon le compte suivant verrait les messages
   du précédent ;
3. les enveloppes sont **acquittées**, donc le serveur ne les ressert pas.

Chacune est juste. Ensemble, elles font disparaître l'historique. **Et rien ne
prévenait.**

> 🔴 **Cherchez les rencontres, pas les bogues.** Nous l'avions déjà écrit au
> chapitre 5. Ce défaut-ci en est une deuxième illustration, plus coûteuse.

Deux corrections :

**La restauration automatique.** Le mot de passe est **déjà là** : l'utilisateur
vient de le taper pour se connecter. On ouvre l'archive avec, on restaure, on
l'oublie. C'est le seul moment du cycle de vie où ce secret existe sans qu'on
ait à le redemander.

**L'avertissement avant la déconnexion**, s'il y a du chiffré et aucune
sauvegarde. ⚠️ **On avertit, on n'empêche pas** : se déconnecter est un geste de
sécurité, quelqu'un qui quitte un poste partagé doit pouvoir le faire tout de
suite.

---

## 9. « La sauvegarde s'active une seule fois ? »

Cette question de l'utilisateur a révélé **deux trous** qui rendaient la réponse
fausse.

**① Elle n'aurait protégé que les messages de demain.** `archiver` ne voit que
ce qui passe *après* l'activation. Tout l'historique déjà échangé serait resté
dans le seul cache local — c'est-à-dire exactement ce qu'on cherche à ne plus
perdre. Et personne ne s'en serait aperçu avant de changer d'appareil.

L'activation verse maintenant ce que le cache contient déjà.

> ⚠️ Le cache local est la **seule source possible** : le serveur ne détient plus
> ces textes. Ce qui n'y est pas est déjà perdu.

**② Changer de mot de passe cassait la sauvegarde, en silence.** La serrure
gardait l'ancien. Le ré-enveloppement se fait donc dans l'écran de changement —
**le seul endroit où l'ancien mot de passe est encore connu**.

Le banc vérifie les deux sens, et le second compte autant :

```
  ✓ le NOUVEAU mot de passe ouvre
  ✓ et l'ANCIEN n'ouvre PLUS
```

Si l'ancien marchait encore, changer de mot de passe **n'aurait rien changé**.

---

## 10. Activée par défaut, et le refus qui doit tenir

Décision produit : la sauvegarde s'installe à la première connexion, sans rien
demander. Perdre son historique est un piège que personne ne voit venir ; le
défaut doit protéger.

Cela impose une contrepartie, et elle est plus importante qu'il n'y paraît :

> 🔴 **Un refus doit tenir.** Sans mémoire du refus, quelqu'un qui désactive sa
> sauvegarde la retrouverait recréée à la connexion suivante. Il la supprimerait
> encore. Et encore.
>
> Ce ne serait pas une maladresse d'affichage : ce serait **passer outre une
> décision explicite de quelqu'un sur ses propres données**, en silence et de
> façon répétée.

D'où une colonne `users.e2ee_sauvegarde_refusee`. **Sur le compte, pas sur
l'appareil** : un navigateur neuf oublierait le refus, c'est-à-dire exactement
quand la réactivation silencieuse se produirait.

Trois détails qui suivent :

- **effacer vaut refus**, dans la *même* transaction que la suppression ;
- **poser une serrure lève le refus** — c'est le geste par lequel on revient sur
  sa décision ;
- **un échec réseau vaut « refusée »**, jamais « à activer ». Dans le doute on ne
  crée rien : activer par erreur envoie l'historique sur nos serveurs sans que
  personne l'ait demandé.

---

## 11. Le tampon, et ce qu'il coûte

Un bloc par message ferait 200 octets de chiffré pour 30 octets de texte —
l'en-tête AES-GCM et le JSON pèsent plus que la charge. On accumule donc.

Mais le tampon est **petit** : dix messages ou dix secondes.

> ⚠️ Ce qui est dans le tampon **n'est pas sauvegardé**. Et ce sont les
> *derniers* messages — ceux dont l'absence se remarque le plus.

Trois filets :

- `visibilitychange`, **pas** `beforeunload` : les navigateurs mobiles ne
  déclenchent pas le second quand on quitte l'application, et c'est précisément
  le moment à couvrir ;
- on vide **avant** la déconnexion ;
- un dépôt raté remet le lot **en tête**, pas en queue — l'ordre chronologique
  doit tenir, sinon la restauration rend un fil dans le désordre.

**Ce n'est pas une garantie.** Le navigateur peut être tué avant que la requête
parte. C'est pour cela que le tampon reste petit : on réduit la fenêtre, on ne
la ferme pas.

---

## 12. La règle qui tient le branchement

Où appeler `archiver` ? La réponse est une règle, pas une liste :

> 🔴 **Partout où l'on met en cache, on archive.**

Ce qui est affiché à l'utilisateur doit être ce qui est sauvegardé. Deux chemins
distincts finiraient par diverger, et la divergence ne se verrait **qu'au moment
de restaurer** — quand l'appareil d'origine n'existe plus.

Trois sites dans le code, dont un qu'on n'atteint qu'après un refus du serveur —
donc jamais pendant un essai ordinaire. C'est la règle qui l'a fait trouver, pas
la lecture.

---

## 13. La troisième serrure : celle qu'on ne retient pas

Les deux premières demandent quelque chose : un mot de passe, ou douze mots
notés quelque part. La troisième ne demande rien — juste le geste que les gens
font déjà tous les jours.

WebAuthn sert habituellement à **se connecter**. Son extension `prf` sert à
autre chose :

```
  même clé d'accès + même sel ──▶ TOUJOURS le même secret (32 octets)
  clé d'accès absente          ──▶ rien, et rien ne le remplace
```

La clé d'accès calcule ce secret à partir de **sa propre clé privée**, qui ne
sort jamais de l'appareil. Il n'est stocké nulle part — ni chez nous, ni dans
le navigateur. Il est **recalculé** à chaque fois, après vérification.

> 🔴 **Ce secret ne nous traverse jamais.** Contrairement à la serrure « mot de
> passe » — que notre serveur reçoit à chaque connexion — celle-ci reste fermée
> même si nous sommes compromis. C'est la plus forte des trois.

### Deux décisions qui évitent une table

**Clé découvrable** (`residentKey: "required"`). Sans cela, il faudrait
connaître l'identifiant de la clé pour la redemander — donc le ranger sur le
serveur, donc une table de plus. Une clé découvrable se retrouve toute seule.

**Deux appels à la création.** Certains navigateurs ne rendent pas le résultat
PRF au moment de créer la clé. On crée, puis on demande : une vérification de
plus, **une seule fois**, contre un chemin qui marche partout.

### Le sel PRF est une constante — et c'est cohérent

Au §4, nous avons posé que les paramètres de dérivation vivent **avec** la
serrure. Ici, le sel PRF est une constante dans le code. Contradiction ?

Non, et la distinction est instructive :

| | durcir un coût | changer le sel PRF |
|---|---|---|
| effet | protection accrue | **autre secret** |
| veut-on le faire ? | oui, un jour | jamais |
| conséquence sur l'existant | doit rester lisible | serrure morte |

> **Un paramètre qu'on ne fera jamais évoluer n'a rien à faire en base.** L'y
> ranger suggérerait le contraire à qui lira le code plus tard.

Et comme le secret PRF fait 256 bits tirés au sort, il suit la règle du §3 :
**une seule itération**. L'étirer coûterait sans rien protéger.

### Ce qu'un banc peut prouver, et ce qu'il ne peut pas

WebAuthn n'existe que dans un navigateur, derrière une vérification humaine. Il
n'y a pas de bibliothèque à simuler.

Le banc utilise donc un **authentificateur virtuel** (protocole DevTools de
Chrome), qui se comporte comme un vrai : clé découvrable, secret PRF stable. Le
cycle complet est éprouvé — poser la serrure, tout effacer en local, rouvrir
**sans rien taper** :

```
④ Rouvrir SANS mot de passe ni clé de récupération
  ✓ le trousseau seul ouvre l'archive
  ✓ et rend les quatre messages

⑤ Sans la clé d'accès, la serrure ne sert à rien
  ✓ sans l'appareil, le trousseau n'ouvre PAS
  ✓ mais les autres serrures restent
```

Le ⑤ compte autant que le ④ : on **retire** l'authentificateur — l'appareil
perdu, volé, ou simplement un autre navigateur — et la serrure doit échouer.
C'est le comportement correct, et c'est pour cela que la clé de récupération
existe à côté.

> ⚠️ **Ce qu'aucun banc automatique ne prouvera : que Face ID marche.** Il
> faudrait un visage. Ce qui est prouvé, c'est que notre code demande la bonne
> chose et en fait le bon usage.

### Un dernier détail d'écran

Le bouton « Restaurer avec cet appareil » n'est **pas désactivé** quand le champ
de secret est vide — contrairement aux deux autres. C'est tout l'intérêt de
cette serrure, et l'écran doit le montrer.

Et on ne le propose que si le navigateur sait faire :

> ⚠️ Un bouton qui échouera après une demande de Face ID est **pire** que pas de
> bouton : la personne croit avoir raté quelque chose.

---

## 14. Où nous en sommes

| | |
|---|---|
| X3DH + Double Ratchet | ✅ |
| Lot 0 — fuites et manques | ✅ |
| Codes de sécurité | ✅ |
| Purge des enveloppes | ✅ |
| **Archive chiffrée, clé maîtresse aléatoire** | ✅ **(ce chapitre)** |
| **Serrure mot de passe (Argon2id)** | ✅ **(ce chapitre)** |
| **Clé de récupération (12 mots)** | ✅ **(ce chapitre)** |
| **Restauration automatique à la connexion** | ✅ **(ce chapitre)** |
| **Activée par défaut, refus mémorisé** | ✅ **(ce chapitre)** |
| **Serrure « trousseau » (WebAuthn PRF)** | ✅ **(ce chapitre)** |
| Chiffrement des médias | ⏸️ remis |
| Client mobile | ⏳ |

**Bancs** : `e2ee-serrures` (28 contrôles), `e2ee-archive-banc` (22 gardes
serveur), `e2ee-sauvegarde` (chemin complet), `e2ee-navigateur` et `e2ee-ecran`
(vrai Chrome), `e2ee-trousseau` (authentificateur virtuel). Tous verts.

---

## 15. Ce qu'il faut retenir

1. **Confidentialité persistante et sauvegarde durable sont contradictoires.**
   Il faut deux boîtes, pas une boîte plus maligne.

2. **Une clé tirée au sort qu'on enveloppe** vaut mieux qu'une clé dérivée d'un
   secret. C'est ce qui permet trois serrures, et un changement de mot de passe
   à 32 octets.

3. **L'étirement compense un manque d'entropie.** Il n'a de sens que pour un
   secret qui se devine. L'appliquer partout coûte sans protéger — et pousse à
   réduire là où ça compte.

4. **Les paramètres vivent avec la donnée, pas dans le code.** Sinon durcir les
   réglages rend illisible tout ce qui existe déjà.

5. **Ne rangez pas de vérificateur de secret.** AES-GCM authentifie ; un haché à
   côté n'est qu'une cible hors ligne.

6. **Un avertissement se lit avant, ou ne se lit pas.** Sa position fait l'effet,
   pas sa présence — et cela se teste par la géométrie.

7. **Une précaution qui rend une chose inutilisable n'est pas une précaution.**

8. **Un refus doit tenir.** Un défaut qui se réactive tout seul ne respecte pas
   une décision, il l'ignore poliment.

9. **Cherchez les rencontres, pas les bogues.** Deuxième fois dans ce cours que
   trois décisions correctes produisent un défaut.

10. **Une spécification n'est pas une mesure.** Ce que fait le navigateur se
    vérifie dans un navigateur.

11. **Un paramètre qu'on ne fera jamais évoluer n'a rien à faire en base.**
    L'y ranger suggère qu'on pourrait le changer — ici, cela tuerait la
    serrure.

12. **Ne proposez pas ce que vous ne pouvez pas tenir.** Un bouton qui
    échouera après une demande de vérification est pire que pas de bouton.
