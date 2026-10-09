# Chapitre 4 — Le coffre local, et ce que le chiffrement local protège vraiment

> **Où nous en sommes.** Les trois premiers chapitres ont construit le
> chiffrement, l'ont branché au fil, et l'ont rendu instantané. Pendant tout ce
> temps, les clés privées dormaient **en clair** dans `localStorage`.
>
> Le commentaire en tête de `e2ee-store.ts` le disait depuis le premier jour :
> *« insuffisant pour la production »*. Ce chapitre solde cette dette — et
> l'occasion est bonne pour parler d'une chose plus difficile : **ce qu'une
> protection ne protège pas.**

---

## 1. Ce qui dormait en clair

Ouvrez la console d'un navigateur, avant ce chapitre :

```js
localStorage.getItem("alanya.e2ee.identite")
// {"pubKey":"BV33uPEc…","privKey":"iLp2KQ…"}   ← la clé PRIVÉE
```

Tout y était : l'identité, les pré-clés privées, l'état complet du Double
Ratchet. C'est-à-dire **tout ce qui permet de lire les messages**.

N'importe quel script s'exécutant sur cette origine — une extension, une
bibliothèque tierce compromise, une injection — pouvait le lire **et le recopier
ailleurs**.

Le vol était :

- **silencieux** — rien à l'écran ne change ;
- **définitif** — une clé volée reste valable ;
- **rejouable à froid** — l'attaquant déchiffre chez lui, des mois plus tard.

---

## 2. La correction, et sa ligne décisive

Les secrets passent dans **IndexedDB**, chiffrés par une clé AES-GCM. Et cette
clé est rangée… **dans IndexedDB aussi**.

Ce qui devrait vous faire tiquer. Ranger la clé à côté de ce qu'elle protège,
n'est-ce pas mettre la clé sous le paillasson ?

**Non — à cause d'un seul mot :**

```js
const neuve = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  false,                          // ← extractable
  ["encrypt", "decrypt"],
);
```

`extractable: false` change la nature de l'objet. Le `CryptoKey` devient une
**poignée**, pas une valeur. Le navigateur garde la matière de son côté et
refuse de la rendre :

```js
await crypto.subtle.exportKey("raw", cle)
// ❌ DOMException: key is not extractable
```

On peut **s'en servir**. On ne peut pas **l'emporter**.

Et un `CryptoKey` se range tel quel dans IndexedDB : le navigateur le sérialise
par sa propre voie, sans jamais exposer sa matière au JavaScript.

```
  AVANT                          APRÈS
  ─────                          ─────
  localStorage                   IndexedDB
    identite : {privKey:"iLp…"}    cle     : ⟨poignée non extractible⟩
    session… : {rootKey:"…"}       secrets : {iv:…, chiffre:⟨octets⟩}
       ▲                                         ▲
   lisible, copiable              chiffré ; la clé ne sort pas
```

---

## 3. 🔴 Ce que cela ne protège pas

**C'est la partie la plus importante de ce chapitre.**

Il serait facile — et flatteur — d'écrire « les clés sont maintenant chiffrées,
donc protégées ». Ce serait faux, et une fausse assurance est pire qu'une
absence de protection : elle fait renoncer aux vraies défenses.

### Ce qui change vraiment

| menace | avant | après |
|---|---|---|
| lecture naïve du stockage | 🔴 clés en clair | ✅ chiffré |
| **exfiltration** des clés | 🔴 copier-coller | ✅ **impossible** |
| script hostile **actif** sur la page | 🔴 | 🟠 **peut encore déchiffrer** |
| accès au profil sur le disque | 🔴 | 🟠 **pas garanti** |

### La ligne à retenir

> On passe de **« copier et partir »** à **« être présent et agir »**.

Un attaquant ne peut plus prendre une copie et la déchiffrer tranquillement
ailleurs. Il doit **exécuter du code sur cette machine, pendant que la session
est ouverte**, et exfiltrer les messages déchiffrés un par un.

C'est beaucoup plus difficile, beaucoup plus bruyant, et beaucoup plus limité.
**Ce n'est pas la même chose qu'impossible.**

> ### 🎓 La leçon
>
> **Une mesure de sécurité se décrit par ce qu'elle déplace, pas par ce qu'elle
> supprime.**
>
> « Les clés sont chiffrées » ne veut rien dire tant qu'on n'a pas dit *chiffrées
> contre qui*. Ici : contre celui qui lit le stockage, pas contre celui qui
> exécute du code.
>
> Le corollaire pratique : **ceci ne remplace pas une CSP**, et ne rend pas une
> XSS inoffensive. Si nous nous en servions pour justifier de ne pas durcir le
> reste, nous aurions reculé au lieu d'avancer.

---

## 4. Le problème qu'on ne voyait pas venir : le synchrone

`localStorage` est **synchrone**. IndexedDB est **asynchrone**.

Or l'interface que la bibliothèque Signal impose appelle nos lectures **au
milieu d'un déchiffrement**. Tout convertir en asynchrone remonterait jusque
dans le protocole — qu'on ne réécrit pas.

**La solution** : le coffre charge tout en mémoire une fois, sert les lectures
depuis là, et persiste derrière.

```
   ouvrirCoffre()  ──▶  déchiffre tout  ──▶  Map en mémoire
                                                  │
        lire()  ◀─────────── synchrone ───────────┘
        ecrire() ──▶ Map  ──▶ file d'écriture ──▶ IndexedDB (chiffré)
```

C'est légitime : le coffre tient dans quelques dizaines de kilo-octets —
quarante sessions au plus, **plafonnées par la bibliothèque elle-même**.

### Deux pièges dans cette file

**La file est sérialisée.** Deux écritures de la même clé lancées en parallèle
peuvent se terminer dans le désordre, et la plus ancienne écraserait la plus
récente. Pour une session de ratchet, cela veut dire **revenir en arrière** — et
ne plus rien savoir déchiffrer.

**On persiste sans attendre**, sans regroupement différé. Le gain de performance
ne vaudrait pas la fenêtre pendant laquelle une session existe en mémoire et pas
sur le disque.

---

## 5. Le bogue que la garde a attrapé

J'ai ajouté ceci, par précaution :

```js
if (!pret) {
  console.error("[e2ee] coffre lu avant `ouvrirCoffre()` — une identité neuve risque d'être créée.")
}
```

Au premier lancement du banc, quatre lignes. Puis :

```
💥 Missing Signed PreKey for PreKeyWhisperMessage
```

Un message **parfaitement valide**, refusé.

### Pourquoi c'était un vrai défaut, pas un artefact de test

Le coffre se charge dans `preparerCetAppareil()`, appelé à la connexion. Mais
**rien n'oblige à passer par là avant de déchiffrer** : `releverEtDechiffrer()`
part du fil de discussion, qui peut s'ouvrir **avant** que la préparation lancée
à la connexion n'ait abouti.

En production, cela aurait donné : ouvrir une conversation trop vite après la
connexion → les messages ne se déchiffrent pas. De temps en temps. Sans
explication.

### La correction

Chaque fonction qui touche au coffre **l'ouvre elle-même**.

```js
export async function dechiffrer(e) {
  await ouvrirCoffre()
  …
}
```

C'est gratuit quand c'est déjà fait : `ouvrirCoffre()` rend la **même** promesse
à tous ses appelants.

> ### 🎓 La leçon
>
> **« Il suffit d'appeler A avant B » n'est pas une garantie.**
>
> C'est une convention qu'aucun test ne vérifie, qu'aucun type n'exprime, et
> qu'un simple changement d'écran suffit à violer. Quand l'ordre compte, c'est à
> **B de s'assurer que A a eu lieu** — pas au lecteur de s'en souvenir.
>
> Et notez d'où est venue la découverte : **d'un message d'erreur que j'avais
> écrit par précaution**, sans y croire vraiment. Une garde bavarde coûte trois
> lignes et attrape ce que les tests ne cherchent pas.

---

## 6. La reprise, ou comment ne pas perdre tout le monde

Un détail qui aurait fait plus de dégâts que le défaut corrigé :

> Sans reprise de l'ancien coffre, **chaque utilisateur perdrait son identité**
> à la mise à jour.

Il en publierait une neuve, l'ancienne resterait en base — muette à jamais — et
chaque message partirait **en double, dont un exemplaire illisible**. On
fabriquerait à grande échelle le problème des *identités mortes* du chapitre 1.

L'ordre des opérations est donc contraint :

```
  1. lire l'ancien localStorage
  2. écrire dans le coffre chiffré
  3. ATTENDRE que l'écriture soit sur le disque
  4. seulement alors, effacer l'ancien
```

Effacer d'abord, c'est perdre l'identité si la page se ferme entre les deux.

---

## 7. Ce qui reste volontairement en clair

Deux choses, et il faut savoir pourquoi :

**Le `deviceId`.** Ce n'est pas un secret : c'est l'identifiant d'appareil que
la connexion **envoie déjà au serveur**. Le chiffrer obligerait `idAppareil()` —
appelé partout, de façon synchrone — à devenir asynchrone, pour un gain nul.

**Le nom des entrées.** `session.bob.1` reste lisible : il sert d'index. Qui
lit le magasin apprend qu'une session existe avec Bob, **pas ce qu'elle
contient**. Ce sont des métadonnées, exactement comme les horodatages côté
serveur — et comme elles, le chiffrement ne les cache pas.

Le banc le vérifie explicitement, pour que ce soit un **choix documenté** et non
un oubli :

```
✓ le NOM des entrées reste visible (métadonnée assumée)
```

---

## 8. Ce que le banc prouve

Trois questions, et ce sont les seules qui comptent :

```
② La clé du coffre est NON EXTRACTIBLE
  ✓ et elle se déclare non extractible
  ✓ exportKey LÈVE — la matière ne sort pas

③ Sur le disque, rien n'est lisible
  ✓ la clé privée n'apparaît NULLE PART en clair
  ✓ l'état du ratchet non plus
  ✓ chaque entrée porte un IV distinct

④ La reprise de l'ancien coffre ne perd pas l'identité
  ✓ l'identité d'avant est reprise
  ✓ l'ancien coffre est vidé derrière
```

⚠️ **Le contrôle ② ne croit pas le booléen.** `extractable === false` est une
déclaration ; on demande **vraiment** l'export, et on vérifie que le navigateur
refuse.

⚠️ **Une limite du banc, à connaître** : `fake-indexeddb` sous Node n'est pas un
navigateur. Que le `CryptoKey` survive au rangement dans IndexedDB **et reste
utilisable** est garanti par la spécification — pas prouvé par ce banc. C'est
un essai navigateur qui le dira.

Et le banc qui compte le plus est celui qu'on n'a **pas** écrit pour l'occasion :
`e2ee-web.mjs`, qui fait passer **le vrai protocole Signal** à travers le
nouveau coffre. Il est vert.

---

## 9. Le tableau de bord

| | état |
|---|---|
| X3DH + Double Ratchet, web | ✅ |
| Périmètre, bannière, avertissement de clé | ✅ |
| Refus du clair — REST et WebSocket | ✅ |
| Remise instantanée | ✅ |
| Cache qui ne perd plus le texte | ✅ |
| **Coffre local chiffré** | ✅ **(ce chapitre)** |
| Comparaison des codes de sécurité | ⏳ **suivant** |
| Archive chiffrée (historique sur un nouvel appareil) | ⏳ |
| Purge des enveloppes remises | ⏳ |
| Chiffrement des médias | ⏸️ remis |
| Groupes (Sender Keys) | ⛔ hors périmètre |
| Client mobile | ⏳ |

---

## 10. Ce qu'il faut retenir

1. **Une protection se décrit par ce qu'elle déplace.** « Chiffré » ne veut rien
   dire sans « contre qui ».

2. **Quand l'ordre des appels compte, c'est au second de s'en assurer.** Une
   convention n'est pas une garantie.

3. **Une garde bavarde coûte trois lignes et attrape ce que les tests ne
   cherchent pas.** Le défaut de ce chapitre a été trouvé par un `console.error`
   écrit sans y croire.

4. **Une migration silencieuse est le vrai danger d'un changement de magasin** —
   bien plus que le magasin lui-même.
