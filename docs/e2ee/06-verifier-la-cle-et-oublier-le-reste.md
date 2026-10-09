# Chapitre 6 — Vérifier la clé, et oublier le reste

> **Où nous en sommes.** Le chiffrement fonctionne, les fuites de périmètre sont
> bouchées. Restaient deux questions que le protocole ne résout pas tout seul :
> *comment savoir que la clé qu'on utilise est la bonne ?* et *combien de temps
> garder ce qu'on ne peut plus lire ?*
>
> Lots 1 et 2 du plan. Branche `feat/e2ee`.

---

## 1. Le trou que le chiffrement ne bouche pas

Reprenons ce que nous avons construit. X3DH met Alice et Bob d'accord sur une
clé sans qu'ils soient connectés en même temps. Le Double Ratchet en dérive une
nouvelle à chaque message. Le serveur transporte des enveloppes qu'il ne peut
pas ouvrir.

Tout cela repose sur **une hypothèse non vérifiée** :

> Quand Alice demande « donne-moi la clé publique de Bob », ce qu'elle reçoit
> est bien la clé de Bob.

Or **c'est le serveur qui distribue les clés**. Il n'a pas le choix : Bob dort,
son téléphone est éteint, quelqu'un doit garder ses clés publiques en attendant.

Un serveur malveillant peut donc donner à Alice **sa propre clé** en prétendant
que c'est celle de Bob. Il fait la même chose avec Bob. Il se retrouve au
milieu : il déchiffre ce qu'Alice envoie, le lit, le rechiffre pour Bob.

**Rien dans le protocole ne le détecte.** Les deux côtés voient une conversation
qui marche parfaitement.

C'est l'attaque de l'homme du milieu, et aucune quantité de cryptographie ne
l'empêche — parce que le problème n'est pas mathématique. Il est **de confiance
initiale**.

---

## 2. La seule sortie : comparer ailleurs

Il n'y a qu'une façon de trancher : **comparer les clés hors du canal**.

De vive voix. En face à face. Par un autre moyen que celui qu'on cherche à
vérifier.

C'est tout ce qu'est un code de sécurité : une représentation courte et lisible
des deux clés publiques, qu'on peut lire à haute voix.

```
  Alice voit :  47291 08634 55172 90048 31766 22509
  Bob voit   :  47291 08634 55172 90048 31766 22509
                └─ identiques → personne au milieu
```

Si un serveur s'est interposé, Alice voit la clé du serveur et Bob aussi — mais
ce ne sont **pas les mêmes**, et les deux codes diffèrent.

> ⚠️ **Ce code n'a de valeur que lu à haute voix ou scanné.** L'envoyer par la
> conversation qu'il doit vérifier est exactement aussi utile que de demander à
> un suspect s'il est coupable. Le serveur qui s'est interposé remplacerait le
> code au passage.

---

## 3. La première erreur : afficher la bonne clé

Voici le piège, et il est redoutable parce que le code fonctionne.

Pour afficher le code, il faut les deux clés publiques. La façon évidente :
demander au serveur.

```js
// ❌ CE QUI NE PROUVE RIEN
const cleDeBob = await api("/api/e2ee/cles/" + bobId)
afficherCode(maCle, cleDeBob)
```

Ça marche. Le code s'affiche. Alice et Bob le comparent, il correspond, ils se
rassurent.

**Et la vérification n'a rien prouvé.**

Un serveur malveillant qui s'est interposé fera parler Alice à un imposteur
**tout en lui montrant la vraie clé de Bob** quand elle la demande. Les deux
codes correspondront. La vérification confirmera une conversation qui est
espionnée.

La règle qui sauve :

> 🔴 **On affiche la clé AVEC LAQUELLE ON PARLE**, pas celle que le serveur dit
> être la bonne.

```js
// ✅ CE QUI PROUVE QUELQUE CHOSE
const cleDeBob = await coffre.loadIdentityKey(bobId)  // le coffre LOCAL
afficherCode(maCle, cleDeBob)
```

La bibliothèque Signal range dans le coffre local la clé qu'elle a réellement
utilisée pour ouvrir la session. **C'est celle-là qu'il faut montrer.** Si le
serveur a triché, c'est sa clé à lui qui est dans le coffre, et le code diverge.

La différence entre les deux versions tient en une ligne. L'une protège,
l'autre décore.

---

## 4. Pourquoi 5 200 itérations

Le code n'est pas un simple condensé des clés. L'algorithme de Signal itère
**5 200 fois** un hachage SHA-512.

Deux raisons, et la seconde surprend.

**① Le coût est la protection.** Un attaquant qui voudrait fabriquer une paire
de clés produisant un code *ressemblant* à celui de Bob doit essayer des
milliards de combinaisons. À 5 200 itérations par essai, la recherche devient
impraticable.

**② Le nombre ne se choisit pas.** C'est celui de Signal, et il doit l'être :

> ⚠️ Deux clients qui n'itèrent pas le même nombre de fois produisent des codes
> **différents pour les mêmes clés**. Les deux personnes concluraient à une
> interposition qui n'existe pas — et cesseraient de se faire confiance.

Un paramètre de sécurité peut donc être **un paramètre d'interopérabilité**. Le
« durcir » casserait la fonctionnalité.

**Mesuré :** ~450 ms sous Node, **108 ms dans Chrome**. Le navigateur fait
tourner SHA-512 bien plus vite que la bibliothèque JavaScript pure — nous
reviendrons au chapitre suivant sur la raison pour laquelle cette mesure a dû
être refaite dans un vrai navigateur.

---

## 5. Le deuxième sujet : que garder, et combien de temps

Passons à l'autre question. Le serveur accumule des enveloppes chiffrées. Quand
peut-on les supprimer ?

La réponse tient dans une propriété du Double Ratchet qu'il faut bien
comprendre :

> 🔴 **Une enveloppe acquittée est définitivement indéchiffrable.**

Quand Bob déchiffre un message, son ratchet **avance** et détruit la clé de ce
message. C'est la confidentialité persistante : si son téléphone est saisi
demain, les messages d'hier restent fermés.

Conséquence directe : garder le chiffré ne sert à rien. **Personne** ne peut
plus l'ouvrir — ni nous, ni Bob, ni un attaquant.

D'où deux seuils :

| | |
|---|---|
| enveloppe **acquittée** | supprimée après **30 jours** |
| enveloppe **jamais relevée** | supprimée après **90 jours** |

Le second est plus long parce que ces enveloppes-là sont encore lisibles : un
appareil éteint depuis deux mois doit pouvoir les relever en revenant.

---

## 6. La règle qui rend une purge sûre

Une purge est un morceau de code dangereux. Voici la règle apprise ici :

> 🔴 **Une purge se teste dans les DEUX sens**, et le second compte plus que le
> premier.

Supprimer **trop peu** coûte des octets. Supprimer **trop** coûte un message que
personne ne pourra jamais reconstituer.

Un banc qui vérifie « il en reste moins qu'avant » ne prouve rien du tout. Le
banc pose donc des enveloppes **de tous les âges** et vérifie, pour chacune,
qu'elle part **ou** qu'elle reste :

```
  acquittée il y a 45 j  →  doit PARTIR     ✓
  acquittée il y a 10 j  →  doit RESTER     ✓
  jamais relevée, 100 j  →  doit PARTIR     ✓
  jamais relevée,  40 j  →  doit RESTER     ✓   ← celui qui compte
```

La quatrième ligne est la plus importante. C'est une enveloppe **encore
lisible**, qui attend un appareil éteint. La supprimer serait une perte
silencieuse et définitive.

---

## 7. Une dette assumée, et pourquoi elle est écrite

Le banc de purge **rejoue** la logique au lieu d'importer la fonction :

```js
/*
 * ⚠️ IL REJOUE LA LOGIQUE DE `purgeEnveloppesChiffrees` (ws-server.mjs) plutôt
 * que d'importer la fonction : elle vit dans un module qui ouvre des sockets et
 * des minuteurs au chargement. Les deux seuils sont donc écrits ICI AUSSI, et
 * c'est le risque connu de ce banc — les faire diverger le rendrait muet.
 */
```

Ce commentaire mérite qu'on s'y arrête. Il ne s'excuse pas : il **nomme le
risque**.

Si quelqu'un change le seuil dans `ws-server.mjs` sans le changer ici, le banc
continuera de passer **en testant autre chose que le code réel**. Un banc muet
est pire qu'aucun banc, parce qu'il rassure.

> **Une dette écrite est une dette qu'on peut rembourser. Une dette tue est un
> piège posé pour soi-même.**

---

## 8. Où nous en sommes

| | |
|---|---|
| X3DH + Double Ratchet | ✅ |
| Périmètre, bannière, avertissements | ✅ |
| Coffre local chiffré | ✅ |
| Lot 0 — fuites et manques | ✅ |
| **Codes de sécurité** | ✅ **(ce chapitre)** |
| **Purge des enveloppes** | ✅ **(ce chapitre)** |
| Archive chiffrée, trois serrures | ⏳ **suivant** |
| Chiffrement des médias | ⏸️ remis |
| Client mobile | ⏳ |

---

## 9. Ce qu'il faut retenir

1. **Le chiffrement suppose que les clés distribuées sont les bonnes.** C'est le
   serveur qui les distribue. Cette hypothèse ne se vérifie que hors du canal.

2. **Afficher la clé que le serveur annonce ne prouve rien.** Il faut afficher
   celle avec laquelle on parle vraiment — celle du coffre local. Une ligne de
   différence, et tout le sens de l'écran bascule.

3. **Un code de vérification envoyé dans le canal qu'il vérifie ne vaut rien.**
   Il se lit à haute voix, ou il ne sert pas.

4. **Un paramètre de sécurité peut être un paramètre d'interopérabilité.**
   Durcir 5 200 itérations casserait la comparaison entre clients.

5. **Ce qu'on ne peut plus lire ne mérite pas d'être gardé.** La confidentialité
   persistante rend la purge non seulement possible, mais évidente.

6. **Une purge se prouve dans les deux sens.** « Il en reste moins » n'est pas un
   test.

7. **Une dette écrite est remboursable ; une dette tue est un piège.**
