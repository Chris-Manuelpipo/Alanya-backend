# Chapitre 21 — Ne pas croire le serveur

> **Où nous en sommes.** 29/09/2026. Lot C de la campagne. Le chiffrement de
> bout en bout repose sur une promesse : *même un serveur compromis ne lit
> rien*. Ce lot cherche les endroits où les clients **croyaient** encore le
> serveur sur parole — et où cette confiance suffisait à trahir la promesse.
>
> Web `5f7fa04` — mobile `803e303`.

---

## 1. Le modèle de menace, dit simplement

Le serveur voit passer tout le trafic. Le chiffrement fait qu'il ne peut pas
**lire** le contenu. Mais il reste maître de trois choses :

1. ce qu'il **dit** aux clients (« ce fil n'est pas chiffré ») ;
2. ce qu'il leur **livre** (un message en clair qu'il a fabriqué) ;
3. les **étiquettes** posées autour des chiffrés (tel texte appartient à tel
   message).

Chacune de ces trois portes était ouverte. Un client correct doit se méfier des
trois.

---

## 2. « Ce fil n'est pas chiffré »

Chaque client apprenait du serveur, et de lui seul, qu'un fil était chiffré. Il
rangeait cette réponse **en mémoire** : vide à chaque rechargement.

Un serveur compromis n'avait qu'à répondre `e2eeActif: false`. Le client
repartait sur le chemin ordinaire et envoyait **le texte en clair**, sans rien à
l'écran. Le chiffrement était désactivé par une simple phrase.

### La règle qui ferme la porte : un fil chiffré le reste

Aucune route du serveur ne désactive le chiffrement d'un fil. Un « non » après
un « oui » n'a donc **aucune explication honnête**. Le client :

- **mémorise** le « oui », par compte (web : `localStorage` ; mobile : le
  coffre) ;
- **ignore** tout « non » qui suit ;
- **demande** l'état avant d'envoyer, quand il ne le connaît pas encore.

Si le serveur ment, le client chiffre quand même, et le serveur refuse le dépôt
(lot B : le dépôt exige un fil chiffré). L'envoi **échoue ouvertement** au lieu de
fuir en silence.

> ⚠️ **Pourquoi `localStorage` suffit sur le web.** Ce n'est pas un secret : on
> ne cherche pas à le cacher à l'utilisateur, on cherche à ne pas dépendre du
> serveur. La menace est à distance, pas sur l'appareil.

> ⚠️ **Effet de bord utile.** L'avertissement « vous allez perdre vos messages
> chiffrés » avant une déconnexion comptait les fils chiffrés… en mémoire. Après
> un démarrage à froid, il comptait zéro et ne s'affichait pas. La mémoire le
> corrige au passage.

---

## 3. Le message en clair qu'il glisse

Le serveur refuse tout texte en clair dans un fil chiffré. Donc un texte en clair
qui **arrive** dans un fil chiffré ne peut venir que de lui — erreur ou
interposition. Il s'affichait pourtant comme les autres, sous la bannière
« chiffré de bout en bout ».

Désormais, il est traité comme un message **sans contenu** : la relève va
chercher son enveloppe, et seule l'enveloppe fait foi.

> ⚠️ **Les avis système sont épargnés** (« chiffrement activé », avis de
> blocage…) : ils portent un contenu légitime, et ce ne sont pas des paroles
> attribuées à quelqu'un.

---

## 4. L'étiquette mal collée

Une enveloppe arrive avec des **métadonnées** fournies par le serveur : l'identifiant
du message, le fil. Elles sont **hors du chiffré**. Le client appliquait le texte
déchiffré à n'importe quelle ligne portant cet identifiant.

Le serveur pouvait donc prendre le texte de Bob et le coller sur un message
d'**Alice** : Alice « disait » les mots de Bob, et son vrai texte, dernière copie
existante, était écrasé en cache.

### Ce qui est sûr, et ce qui ne l'est pas

Tout n'est pas falsifiable. **L'expéditeur est authentifié** : pour déchiffrer, on
utilise *sa* session. Si le serveur ment sur l'expéditeur, le déchiffrement échoue.

Il suffit donc d'exiger que la ligne visée soit **de cet expéditeur, dans ce
fil**. Le serveur ne peut plus faire parler personne d'autre.

| attaque | avant | après |
|---|---|---|
| texte de Bob sur un message d'Alice | ✅ réussit | ❌ écarté |
| texte de Bob dans un autre fil | ✅ réussit | ❌ écarté |
| texte de Bob sur un **autre** message **de Bob**, même fil | ✅ réussit | ✅ **réussit encore** |

La dernière ligne demande de chiffrer l'identifiant **avec** le texte, pour que le
destinataire le vérifie après déchiffrement. C'est une évolution du **protocole** :
les deux clients doivent la comprendre avant qu'aucun ne l'envoie, sinon un ancien
APK afficherait le paquet brut. Elle est reportée, et le dire vaut mieux que de
laisser croire la porte fermée.

> ⚠️ **Un texte écarté n'est pas archivé non plus.** Sinon il ressusciterait à
> la restauration sur un autre appareil — le piège du chapitre 19.

---

## 5. Les erreurs du chemin

- **Un banc qui passait par la mauvaise porte.** Mon premier scénario ⑤ faisait
  écrire Alice par `envoyerChiffre`, la fonction de bas niveau. Or c'est
  `sendChatMessage`, le chemin de l'écran, qui range le texte dans son cache.
  Sans ce rangement, il n'y avait rien à protéger, et le contrôle échouait pour
  une mauvaise raison. **Un banc doit emprunter le même chemin que
  l'utilisateur.**
- **Un scénario qui laissait l'état derrière lui.** L'étape ④ quittait le fil
  « non chiffré » ; l'étape ⑤ échouait alors sur le refus des pré-clés (lot B).
  Chaque étape doit poser elle-même l'état dont elle a besoin.
- **Une coupure de courant au milieu du lot.** Rien n'était commité. On a
  vérifié qu'aucun fichier n'avait été rempli de zéros avant de reprendre — une
  corruption de ce genre a déjà eu lieu sur ce poste (23/09).

---

## 6. Ce qui reste ouvert

- **Chiffrer l'identifiant avec le texte** (section 4) : une évolution du
  protocole, à faire des deux côtés ensemble.
- **Lier une session à son appareil de chiffrement, côté serveur.** Aujourd'hui,
  n'importe quelle session d'un compte peut relever les enveloppes d'un autre
  appareil du même compte, ou remplacer sa clé. Il faut que le jeton de session
  porte l'appareil, et une migration de base. Soumis au user.

---

## 7. À retenir

1. **Tout ce que dit le serveur est une affirmation, pas un fait.** Chiffré ou
   non, de qui, pour quel message : chaque réponse doit être vérifiable, ou au
   moins ne jamais pouvoir faire moins protéger.
2. **Une protection ne redescend jamais sur la parole d'un tiers.**
3. **Ce qui est authentifié sert d'ancre.** L'expéditeur l'est ; on y accroche
   le reste.
4. **Dire ce qui reste ouvert.** Une porte à moitié fermée qu'on présente comme
   fermée est pire qu'une porte ouverte qu'on surveille.
