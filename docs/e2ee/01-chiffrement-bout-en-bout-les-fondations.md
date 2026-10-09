# Chapitre 1 — Le chiffrement de bout en bout : les fondations

> **Où nous en sommes.** Les tables, les routes et le client web existent, et la
> chaîne complète a été éprouvée : Alice écrit, le serveur transporte sans
> comprendre, Bob lit. Ce chapitre explique *pourquoi* chaque pièce a la forme
> qu'elle a — et raconte les quatre erreurs commises en chemin, qui en
> apprennent plus que le code final.
>
> Branche `feat/e2ee`, sur `backend-alanya` et `STAGE-WEB`. Rien n'est en
> production.

---

## 1. La question à laquelle tout répond

« Chiffré » ne veut rien dire tout seul. HTTPS chiffre déjà tout ce qui circule
entre ton téléphone et notre serveur. La vraie question est ailleurs :

> **Le serveur peut-il lire les messages ?**

Avec HTTPS seul : **oui**. Le message arrive chiffré, le serveur le déchiffre, le
range en clair dans `messages.content`, puis le rechiffre pour le destinataire.
Quiconque accède à la base lit tout.

Avec le chiffrement de bout en bout : **non**, et c'est une impossibilité
mathématique, pas une promesse. Le serveur ne détient aucune clé permettant
d'ouvrir quoi que ce soit.

**C'est la seule propriété qui compte.** Tout le reste de ce chapitre n'existe
que pour la garantir.

---

## 2. Le problème que Signal a résolu

Chiffrer entre deux personnes connectées en même temps est facile : elles
s'échangent des clés, et voilà.

**Mais une messagerie n'est pas comme ça.** Tu écris à quelqu'un dont le
téléphone est éteint. Il lira demain. Comment se mettre d'accord sur une clé
secrète avec quelqu'un d'absent ?

Signal répond en deux temps, avec deux protocoles distincts qu'il ne faut jamais
confondre.

### X3DH — se mettre d'accord avec un absent

Chaque appareil **dépose à l'avance** chez le serveur un petit lot de clés
**publiques**. Qui veut écrire les récupère et calcule le secret partagé tout
seul, sans que l'autre bouge.

C'est ce dépôt anticipé qui rend le chiffrement asynchrone possible. Sans lui,
rien de tout cela ne marcherait pour une messagerie.

### Double Ratchet — une clé neuve à chaque message

Une fois le secret établi, chaque message est chiffré avec une **clé différente**,
dérivée de la précédente et jetée aussitôt.

Conséquence : voler la clé d'aujourd'hui ne donne pas les messages d'hier
(*confidentialité persistante*), ni ceux de demain (*auto-guérison*).

> ⚠️ **Le spec du Double Ratchet n'a aucun composant serveur.** Il est
> strictement de client à client. C'est pour cela que tu ne trouveras dans nos
> tables **aucune** trace de session — et si tu en vois apparaître une un jour,
> c'est que quelque chose a mal tourné.

---

## 3. Ce que nous avons construit

### Le partage, en une ligne

| Chez le serveur | Chez le client |
|---|---|
| Clés **publiques** | Clés **privées** |
| Messages **déjà chiffrés** | État des sessions |
| Qui parle à qui, quand | Le contenu |

### Les quatre tables

```
e2ee_identites          une par APPAREIL : clé publique d'identité
  └── e2ee_prekeys_signees    la pré-clé renouvelée, + sa signature
  └── e2ee_prekeys_uniques    le stock à usage unique

e2ee_enveloppes         les messages chiffrés, un par appareil destinataire
```

### 🔴 La chose la plus importante à comprendre

> **Le chiffrement est par APPAREIL, jamais par compte.**

Ton compte ouvert sur un téléphone et un navigateur, ce sont **deux identités
cryptographiques distinctes**. Un message t'est chiffré **deux fois**, une fois
pour chaque appareil, et chaque chiffré est illisible par l'autre.

Ranger ces clés au niveau du compte est l'erreur de conception la plus coûteuse
ici — parce qu'elle **ne se voit qu'à l'usage**, le jour où un second appareil ne
lit plus rien.

### Pourquoi une table d'enveloppes séparée de `messages`

`messages` porte du texte **en clair** et tout l'historique. Y greffer du chiffré
mélangerait deux régimes dans les mêmes colonnes, et la moindre requête oubliée
exposerait l'un en croyant lire l'autre.

Deux tables, deux régimes, aucune confusion possible.

---

## 4. Les gardes qui ne se devinent pas

### La pré-clé à usage unique est consommée *atomiquement*

```sql
UPDATE e2ee_prekeys_uniques SET consomme_le = now()
WHERE id = $1 AND consomme_le IS NULL   -- ← la condition est tout
```

En servir deux fois la même détruit la confidentialité persistante de la
première session. Un « lire puis écrire » laisserait deux requêtes simultanées
emporter la même — et **ce défaut ne se voit jamais à l'exécution**.

### La pré-clé signée n'est pas effacée à la rotation

Quelqu'un a pu récupérer ton paquet juste avant que tu le renouvelles, et écrire
une minute après. Supprimer d'office rendrait ce message-là indéchiffrable, sans
que rien ne l'explique.

### La relève ne marque pas « remis »

Le client peut perdre la réponse, ou planter en plein déchiffrement. Marquer à
l'envoi perdrait le message **définitivement** — personne d'autre ne l'a, et le
serveur ne peut pas le reconstituer. C'est un accusé de réception **explicite**
qui retire.

### La signature est ce qui empêche le serveur de tricher

Sans elle, le serveur servirait sa propre pré-clé fabriquée, lirait tout, et
rechiffrerait vers toi sans que personne ne s'en doute. Le client **doit**
vérifier cette signature contre la clé d'identité — la ranger sans la vérifier
ne protège de rien.

---

## 5. Les quatre erreurs, et ce qu'elles enseignent

> Cette section vaut le reste du chapitre. Le code final ne dit jamais pourquoi
> il a cette forme ; les erreurs, si.

### Erreur n° 1 — un `.catch` qui transforme une panne en mystère

```js
const { hashPassword } = await import("../src/lib/password.js")
  .catch(() => ({}))          // ← le piège
```

Node ne sait pas lire du TypeScript. L'import échouait, le `.catch` l'avalait,
`hashPassword` valait `undefined`, et le compte partait en base **sans mot de
passe**.

Symptôme observé : `401 Identifiants incorrects` à la connexion.

**On a donc cherché le défaut dans la route d'authentification**, alors qu'il
était dans la préparation du test, vingt lignes plus haut.

> **Leçon.** Un `catch` qui rend un objet vide convertit une panne bruyante en
> panne muette, et **déplace le symptôme loin de sa cause**. En cryptographie
> c'est particulièrement grave : la plupart des défauts n'ont déjà aucun symptôme
> visible.

### Erreur n° 2 — un banc d'essai qui suppose au lieu de poser

Le script ne créait le compte *que s'il n'existait pas*. Or le premier essai en
avait déjà déposé un, infirme. Les exécutions suivantes le retrouvaient et
échouaient **pour une cause déjà corrigée**.

> **Leçon.** Un banc d'essai **ramène le monde dans l'état qu'il attend**, il ne
> suppose jamais l'avoir trouvé. D'où le passage à un `upsert`.

### Erreur n° 3 — l'état cryptographique s'accumule

Chaque exécution tirait un nouvel identifiant d'appareil et publiait un jeu de
clés de plus. Bob se retrouvait avec **plusieurs identités** en base. Alice,
obéissante, chiffrait pour chacune. Bob ne savait lire que la dernière.

Message obtenu : `No record for device <uuid>.<numéro>`.

> ⚠️ **Ce n'est pas un défaut du protocole — c'est son fonctionnement normal.**

Et c'est exactement ce qui arrivera en vrai le jour où quelqu'un désinstallera
puis réinstallera : ses anciennes identités restent publiées, et ses
correspondants continuent de chiffrer pour un appareil qui ne lira plus rien.

> 🔴 **Dette de production identifiée par ce test.** Il faut un moyen de
> **retirer** une identité d'appareil : à la déconnexion, et par ménage des
> identités qui ne relèvent plus depuis longtemps. Sans cela, chaque message est
> chiffré pour une pile d'appareils morts, et le stock de pré-clés se vide pour
> rien.

### Erreur n° 4 — le nombre qui ment

Nous avions écrit partout : *« type 1 = ouvre la session, type 3 = session
établie »*, en nous fiant aux noms `PreKeyWhisperMessage` et `WhisperMessage`.

**C'est l'inverse.** La bibliothèque hérite de `libsignal-protocol-javascript` :

```
WHISPER       = 1     (session déjà établie)
PREKEY_BUNDLE = 3     (ouvre la session)  ← le premier message
```

Le symptôme ? En déchiffrant avec la mauvaise méthode, on obtient... `No record
for device`. **Le même message que l'erreur n° 3.** Un message qui parle
d'*appareil* et envoie fouiller du côté des identités publiées, alors que le
coupable est un nombre.

> **Leçon.** En cryptographie, les messages d'erreur désignent rarement le
> coupable : ils décrivent l'endroit où la chaîne s'est cassée, pas celui où
> l'hypothèse était fausse. C'est ce qui rend les tests mécaniques
> indispensables — et les noms parlants, dangereux quand on ne vérifie pas les
> valeurs derrière.

Les deux nombres sont désormais **nommés** (`TYPE_PREKEY = 3`) pour qu'on n'ait
plus à s'en souvenir.

---

## 6. Ce que le banc d'essai vérifie

`node scripts/e2ee-banc.mjs`, backend démarré. Douze contrôles :

| | Contrôle |
|---|---|
| ① | Deux comptes distincts existent |
| ②  | Connexion par la **vraie** route, jeton obtenu |
| ③ | Les clés publiques sont publiées |
| ④ | **Aucune clé privée en base** |
| ⑤ | X3DH : la session s'ouvre depuis un paquet de pré-clés |
| ⑥ | La pré-clé unique est bien **consommée** (5 → 4) |
| ⑦ | Une enveloppe **par appareil**, de type 3 |
| ⑧ | **Le clair n'apparaît nulle part dans le corps stocké** |
| ⑨ | Bob déchiffre, et **le texte revient identique** |
| ⑩ | L'accusé de réception retire l'enveloppe |
| ⑪ | La conversation continue dans l'autre sens |
| ⑫ | Un destinataire hors conversation est **refusé** |

> ⚠️ **Pourquoi un script et non des clics dans un navigateur.** Un défaut de
> chiffrement **ne se voit pas à l'écran** : les messages s'affichent de la même
> façon qu'ils soient bien chiffrés, mal chiffrés, ou pas chiffrés du tout. Seule
> une vérification mécanique — *le clair revient-il ? le corps transporté est-il
> vraiment illisible ?* — a une valeur ici.

Le contrôle ⑧ est le cœur : on relit le corps **tel qu'il est en base** et on
vérifie que le texte n'y est pas. C'est la seule preuve directe que le serveur
ne lit rien.

---

## 7. Ce qui reste ouvert

### 🔴 La bibliothèque du navigateur

**Signal ne publie aucun portage navigateur de `libsignal`.** Le paquet officiel
est un module natif Node ; `libsignal-protocol-javascript` est abandonné.

Nous utilisons `@privacyresearch/libsignal-protocol-typescript` : vraie
sémantique du protocole, mais **sans publication depuis trois ans**.

Cela tient pour développer. **Pas pour la production.** Trois issues à trancher :
auditer ce portage, passer à un WebAssembly maintenu, ou réserver le chiffrement
aux clients natifs, où le paquet officiel existe.

### Les autres dettes

| Dette | Pourquoi elle compte |
|---|---|
| Le changement de clé d'identité n'avertit personne | C'est sur elle que repose la vérification entre deux personnes. Un remplacement silencieux est exactement ce que ferait un serveur qui s'interpose |
| Les identités mortes ne sont jamais retirées | Voir erreur n° 3 |
| Le coffre du web est en `localStorage` | Synchrone, plafonné, lisible par tout script de la même origine. Cible : IndexedDB chiffré par une clé non extractible |
| Aucun code de sécurité à comparer | Sans lui, personne ne peut détecter une interposition |
| Les groupes ne sont pas traités | Signal utilise un autre mécanisme (*Sender Keys*) |

---

## 8. Et ensuite

1. **Brancher le chiffrement au vrai fil de discussion** du web, derrière le
   drapeau `conversation.e2ee_actif`.
2. **Payer les dettes** ci-dessus, en commençant par le retrait des identités
   mortes et l'avertissement sur changement de clé.
3. **Puis seulement le mobile.** Le client Flutter viendra quand le web sera
   pleinement fonctionnel — et il aura sa propre difficulté, le paquet officiel
   `libsignal` y étant utilisable, ce qui change la donne en mieux.

---

*Chapitre suivant : brancher le chiffrement au fil de discussion, et ce que
devient un message quand il cesse d'être lisible par le serveur.*
