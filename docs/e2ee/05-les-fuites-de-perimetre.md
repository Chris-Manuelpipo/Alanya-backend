# Chapitre 5 — Les fuites de périmètre, et l'art de tester ce qui ne doit pas arriver

> **Où nous en sommes.** Le chiffrement fonctionne. Le coffre est chiffré. Les
> messages arrivent instantanément et ne se perdent plus.
>
> Et pourtant, avant ce chapitre, **le mot « chiffré » affiché à l'écran n'était
> pas tenu**.
>
> Aucun des défauts qui suivent n'est un défaut de cryptographie. Tous viennent
> du même endroit : **deux morceaux corrects que personne n'avait mis côte à
> côte.**

---

## 1. La fuite qui n'était le défaut de personne

Notre application traduit les messages. Le module de traduction est bien écrit —
mieux que je ne le croyais. Il met le moteur du navigateur **par défaut**, et il
refuse explicitement de se rabattre sur le relais en ligne :

> *« Pas de repli sur le relais : l'utilisateur a choisi que rien ne sorte de
> son appareil, un échec local ne vaut pas autorisation de sortir. »*

Notre application chiffre les conversations. Le module de chiffrement est bien
écrit aussi : le serveur ne voit jamais le texte.

**Les deux sont corrects. Ensemble, ils fuient.**

### Le scénario, en trois lignes

1. Il y a six mois, l'utilisateur va dans les Réglages et choisit Azure —
   la traduction en ligne est meilleure, c'est un choix raisonnable.
2. Aujourd'hui, il active le chiffrement sur une conversation.
3. Il appuie sur « traduire ».

Le texte **déchiffré** part chez Microsoft. Et dans un **cache partagé entre
comptes**. Pendant que l'écran affiche un cadenas.

### Pourquoi c'est la pire espèce de fuite

**L'utilisateur la déclenche lui-même, en croyant être protégé.**

Rien dans l'interface ne rapproche les deux réglages. Aucun des deux modules
n'est fautif. Aucune revue de code portant sur l'un des deux ne l'aurait vue.

> ### 🎓 La leçon
>
> **Une fonctionnalité correcte peut en casser une autre sans qu'aucune des deux
> ne soit fautive.**
>
> On appelle ça une fuite de **périmètre**. Elle ne se trouve pas en relisant du
> code : elle se trouve en se demandant, pour chaque chose que l'application
> sait faire, *« et si celle-ci rencontrait celle-là ? »*
>
> La liste des rencontres à examiner, pour nous : traduction, notification
> poussée, aperçu de conversation, recherche, export, sauvegarde, pièces
> jointes, réponse citée, transfert. Chacune manipule du texte.

### Et ma propre erreur, qui illustre le chapitre 3

J'avais d'abord écrit ce défaut **en rouge vif** : « la traduction exfiltre le
clair ». C'était **faux**, et le user me l'a dit.

J'avais lu `translate/route.ts` — le relais serveur — et pas
`traduction-service.ts` — le client, qui décide. Exactement la faute contre
laquelle le chapitre 3 met en garde : **n'avoir pas regardé tous les chemins.**

Le défaut réel est bien plus petit : un réglage qui n'est relié à rien. La
correction tient en trois lignes au lieu d'un chantier.

> **Une alerte exagérée coûte cher** : elle fait dimensionner une réponse pour un
> problème qui n'existe pas.

---

## 2. Quand le compilateur porte la règle

La correction pouvait s'écrire ainsi :

```ts
// ❌ Ce qu'il ne fallait pas faire
traduireMessage(texte, langue, conversationId?)   // facultatif
```

Ça marche. Aujourd'hui. Jusqu'au prochain développeur qui ajoute un appel et
n'en sait rien — et la fuite rouvre, **en silence**.

```ts
// ✅ Ce qu'on a fait
traduireMessage(texte, langue, conversationId)    // obligatoire
```

Maintenant, **on ne peut plus traduire sans dire de quelle conversation il
s'agit**. Le compilateur refuse.

> ### 🎓 La leçon
>
> **Quand une règle dépend du contexte, c'est à la fonction de l'exiger.**
>
> C'est la même leçon que le chapitre 4 (« il suffit d'appeler A avant B » n'est
> pas une garantie), sous une autre forme. Une règle portée par la mémoire d'un
> humain est une règle qui sera perdue. Une règle portée par un type est une
> règle qui tient.

---

## 3. Le défaut qui n'était pas une fuite — et qui était pire à l'usage

Dans la liste des conversations, un fil chiffré affichait :

```
  Bob                                    14:32
  📞 Appel manqué
```

…alors que Bob venait d'écrire.

Pourquoi ? `lastMessage` est nul pour un message chiffré — le serveur ne le lit
pas, il ne peut rien en résumer. La liste tombait alors dans le repli prévu pour
les conversations **sans message** : l'aperçu du dernier appel.

**Ce n'est pas une fuite. C'est le contraire : une information fausse.** Et à
l'usage, c'est peut-être pire — l'utilisateur en conclut que son message n'est
pas parti.

### Où mettre le texte « Message chiffré » ?

Tentation : que le serveur l'écrive dans `lastMessage`.

**Non.** L'application parle **neuf langues**, et la règle du projet est
ancienne :

> *« Des CODES, jamais des phrases : le serveur ne rend aucun texte affichable.
> C'est le client qui traduit. »*

Le serveur n'a pas à inventer un texte qu'il ne saurait pas écrire dans la bonne
langue. Le libellé vient donc du client, dans les neuf langues.

> ### 🎓 La leçon
>
> **L'absence d'information n'est pas neutre : elle est remplie par autre chose.**
>
> Un champ laissé vide ne produit pas un écran vide. Il produit un repli — et le
> repli a été écrit par quelqu'un qui ne pensait pas à votre cas.

---

## 4. Le serveur réclamait. Personne n'écoutait.

Celui-ci est mon préféré, parce qu'il ne se voit dans aucune relecture de code.

`GET /api/e2ee/cles` rend ce champ, depuis le premier jour :

```json
{ "prekeysRestantes": 7, "reapproNecessaire": true }
```

Avec ce commentaire, que j'avais écrit moi-même :

> *« ⚠️ C'EST LE SERVEUR QUI RÉCLAME, PAS LE CLIENT QUI DEVINE. […] un stock vide
> signifie que PERSONNE ne peut plus ouvrir de conversation avec cet appareil,
> panne muette s'il en est. »*

**Le client ne lisait ce champ nulle part.**

### Ce que ça donnait

Les 50 pré-clés à usage unique s'épuisent au fil des nouveaux correspondants.
Le jour où il n'en reste plus, **plus personne ne peut ouvrir de conversation
avec cet appareil**.

Et voici ce qui rend la panne redoutable : **elle n'est pas subie par celui qui
la cause**. Son application marche parfaitement. Ce sont les *autres* qui
n'arrivent pas à lui écrire, sans comprendre pourquoi.

Pire : le stock n'était republié qu'à la **connexion**. Quelqu'un qui reste
connecté des semaines — le cas normal sur le web — pouvait le vider sans jamais
repasser par là.

> ### 🎓 La leçon
>
> **Un champ rendu que personne ne lit est du code mort qui a l'air vivant.**
>
> Il rassure à la relecture — « c'est géré, le serveur le signale » — alors que
> rien n'est géré. La contre-mesure est simple et vaut d'être systématique :
> pour chaque valeur qu'une API rend, **chercher qui l'utilise**. Si la réponse
> est « personne », il y a soit un défaut, soit un champ à retirer.

---

## 5. L'alarme qu'on use

Il fallait dire que les pièces jointes ne sont pas chiffrées. Première idée :
en rouge, comme l'alerte de changement de clé.

**Non** — et le raisonnement vaut au-delà de ce cas.

| | fréquence | ce que ça demande |
|---|---|---|
| clé d'un correspondant changée | **rare** | s'arrêter, vérifier |
| pièce jointe non chiffrée | **à chaque fichier** | savoir, décider |

Mettre du rouge sur la seconde userait le rouge. Le jour où la clé d'un
correspondant changerait vraiment, l'utilisateur aurait vu cinquante alertes
rouges sans conséquence, et ne regarderait plus.

L'avertissement est donc **ambre** — la même famille que la bannière du
chiffrement : une mise en garde, pas un danger.

Et il est placé **au moment de choisir le fichier**, pas après l'envoi : quand
l'information peut encore changer la décision.

> ### 🎓 La leçon
>
> **Une alarme a un budget, et il se dépense.**
>
> Chaque avertissement qui ne demande aucune action réduit l'attention portée à
> ceux qui en demandent une. Le silence sur une limite est un défaut ; crier
> pour chaque limite en est un autre.

---

## 6. Tester que quelque chose n'arrive PAS

Tous nos bancs jusqu'ici vérifiaient qu'une fonctionnalité **marche**. Celui-ci
est d'une autre nature :

```
════ BANC DE NON-FUITE ════
```

Il vérifie que du texte déchiffré **ne sort pas** par une porte qu'on n'avait
pas regardée.

### Le piège de ce type de banc

Un banc de non-fuite passe au vert dans **deux** cas :

- ✅ la garde fonctionne ;
- ❌ **on a testé la mauvaise chose**.

Et rien ne distingue les deux. Un banc qui interroge une route inexistante, ou
qui envoie une requête mal formée refusée pour une autre raison, affiche
fièrement « aucune fuite ».

### Les deux contre-mesures

**① Jouer chaque contrôle dans les deux sens.**

```
✓ un fil CHIFFRÉ est refusé
✓ un fil ORDINAIRE n'est pas refusé pour chiffrement    ← indispensable
✓ une traduction HORS conversation reste possible
✓ un fil dont on n'est PAS membre ne révèle pas son état
```

Une garde qui refuse **tout** n'est pas une garde, c'est une panne — et elle
passerait le premier contrôle sans rien protéger.

**② Retirer la garde et exiger le rouge.**

```
  if (fil?.e2eeActif === true) {   →   if (false) {
```

Si le banc reste vert, il ne teste rien. On le jette.

---

## 7. Le défaut que le banc a trouvé — dans ma propre correction

J'avais placé la garde du relais **après** la résolution du fournisseur, en me
disant : « arriver là signifie que le moteur est en ligne, c'est plus propre ».

Le banc a répondu :

```
✗ un fil CHIFFRÉ est refusé
    HTTP 502 {"code":"PROVIDER_UNAVAILABLE"}
```

Sur ce poste, la clé Azure n'est pas configurée. `resoudre` échoue **avant** ma
garde, qui ne s'exécute donc jamais.

> **Elle ne protégeait que les serveurs correctement configurés — c'est-à-dire
> pas celui sur lequel on développe.**

Et sur un serveur bien configuré, elle aurait marché. Le défaut serait resté
invisible jusqu'à ce qu'une clé expire.

### La correction, et la règle qu'elle porte

La garde passe **avant tout le reste** : avant le fournisseur, avant le quota,
avant le cache.

> ### 🎓 La leçon — la plus importante du chapitre
>
> **La confidentialité ne doit jamais dépendre de la configuration.**
>
> Une variable d'environnement absente, un quota atteint, un service tiers en
> panne : aucune de ces circonstances ne doit changer ce que le système laisse
> sortir. Les contrôles de confidentialité passent **en premier**, là où rien ne
> peut les court-circuiter.
>
> Corollaire sur les messages d'erreur : le refus doit porter **son vrai motif**.
> `CONVERSATION_CHIFFREE` et `PROVIDER_UNAVAILABLE` appellent des conduites
> opposées côté client — réessayer autrement, ou renoncer.

---

## 8. Le tableau de bord

| | état |
|---|---|
| X3DH + Double Ratchet, web | ✅ |
| Périmètre, bannière, avertissement de clé | ✅ |
| Refus du clair — REST et WebSocket | ✅ |
| Remise instantanée | ✅ |
| Cache qui ne perd plus le texte | ✅ |
| Coffre local chiffré | ✅ |
| **Traduction confinée à l'appareil** | ✅ **(ce chapitre)** |
| **Notification des messages chiffrés** | ✅ **(ce chapitre)** |
| **Aperçu de conversation honnête** | ✅ **(ce chapitre)** |
| **Pièces jointes : la limite est dite** | ✅ **(ce chapitre)** |
| **Pré-clés réapprovisionnées et bornées** | ✅ **(ce chapitre)** |
| Codes de sécurité | ⏳ **suivant** |
| Archive chiffrée, trois serrures | ⏳ |
| Purge des enveloppes remises | ⏳ |
| Chiffrement des médias | ⏸️ remis |
| Client mobile | ⏳ |

---

## 9. Ce qu'il faut retenir

1. **Une fonctionnalité correcte peut en casser une autre** sans qu'aucune ne
   soit fautive. Cherchez les rencontres, pas les bogues.

2. **Quand une règle dépend du contexte, la fonction doit l'exiger.** Un
   paramètre facultatif est une règle qui sera oubliée.

3. **L'absence d'information n'est pas neutre** : elle est remplie par un repli
   écrit par quelqu'un qui ne pensait pas à votre cas.

4. **Un champ rendu que personne ne lit** rassure à la relecture et ne fait
   rien.

5. **Une alarme a un budget.** Crier pour tout, c'est n'être entendu pour rien.

6. **La confidentialité passe avant la configuration.** Une clé d'API absente ne
   doit pas décider de ce qui sort.

7. **Un banc de non-fuite doit rougir quand on retire la garde**, sinon il ne
   prouve rien. Vérifiez-le à la main, une fois.
