# Chapitre 3 — La sonnette, et le trou qu'elle a révélé

> **Où nous en sommes.** Le chapitre 2 a raccordé le chiffrement au vrai fil :
> Alice écrit, Bob lit, le serveur ne comprend rien. Puis nous avons testé à la
> main, dans un navigateur — et c'est là que le produit a parlé.
>
> Ce chapitre part de **deux phrases** du user, et montre où elles nous ont
> menés. Elles ne décrivaient pas deux bogues. Elles en décrivaient trois, dont
> un que personne ne cherchait.

---

## 1. Les deux phrases

> « à chaque fois que Alice envoie un message à BOB le message n'arrive pas
> instantanément puis lorsque BOB envoi un message à Alice c'est là ou le
> message d'Alice affiche chez BOB **et chez Alice le message devient vide** et
> vice versa à chaque fois »

Lisons-la lentement. Elle contient deux faits distincts :

| fait observé | ce que ça veut dire |
|---|---|
| le message n'arrive pas tout de suite | il manque une **notification** |
| le message déjà affiché **devient vide** | quelque chose **efface** du texte correct |

Le second est le plus grave. Un message en retard finit par arriver ; un message
effacé, lui, a l'air perdu. Et c'est **notre propre code** qui l'effaçait.

---

## 2. Premier défaut — la fusion qui oublie

### Ce qui se passait

L'écran garde une liste de messages. Quand de nouveaux arrivent, il les
**fusionne** avec ceux déjà affichés :

```ts
parId.set(entrant.id, existant ? { ...existant, ...entrant } : entrant)
```

Cette ligne dit : « pour un message déjà connu, écrase ses champs par ceux du
nouveau ». C'est raisonnable — un message peut changer de statut, être supprimé,
être édité.

Sauf que pour un message **chiffré**, le serveur renvoie toujours :

```json
{ "id": "…", "content": null, "chiffre": true }
```

Il ne peut rien renvoyer d'autre : **il ne lit pas le texte**. Alors `{...entrant}`
recopiait ce `null` par-dessus le texte qu'on venait de déchiffrer.

### La séquence exacte que le user a vue

1. Alice envoie « bonjour ». Il s'affiche chez elle.
2. Bob répond. Sa réponse arrive chez Alice **par le temps réel**.
3. L'arrivée déclenche une fusion.
4. La fusion repasse sur TOUS les messages du fil, y compris « bonjour ».
5. « bonjour » perd son texte.

C'est pour ça que ça arrivait « quand l'autre répond » — un détail qui semblait
mystérieux et qui était en fait **l'indice principal**.

### La correction

```ts
const fusionne = { ...existant, ...entrant }
if (!entrant.content && existant.content) fusionne.content = existant.content
parId.set(entrant.id, fusionne)
```

> ### 🎓 La leçon
>
> **Une mise à jour apporte du neuf ; elle ne doit jamais faire OUBLIER.**
>
> La règle n'est pas propre au chiffrement. Elle vaut partout : quand deux
> versions d'un objet se rencontrent, « la plus récente gagne » est un mauvais
> réflexe si la plus récente est **moins complète**. Le bon réflexe est : la
> plus récente gagne **sur ce qu'elle sait**.

---

## 3. Deuxième défaut — personne ne sonnait

### Pourquoi un message ordinaire arrive tout seul

Il faut savoir une chose sur notre architecture : **il y a deux chemins** pour
envoyer un message.

```
                    ┌─────────────────────────────────────────┐
   message          │  ws-server.mjs                          │
   ORDINAIRE  ─────▶│  1. écrit la ligne en base              │
                    │  2. la diffuse aux participants  ◀── la clé
                    └─────────────────────────────────────────┘

                    ┌─────────────────────────────────────────┐
   message          │  POST /api/conversations/:id/messages   │
   CHIFFRÉ    ─────▶│  1. écrit la ligne en base              │
                    │  2. …                                   │
                    └─────────────────────────────────────────┘
```

Le client web préfère toujours le WebSocket, **précisément parce qu'il diffuse**.
Le REST n'est qu'un filet de secours, et il est documenté comme tel :

> « Ne notifie personne : la diffusion temps réel appartient au WebSocket. »

Or nous avions fait passer le chiffrement par le REST — délibérément, pour ne
pas toucher au serveur temps réel. **Conséquence : plus personne ne sonnait.**

Bob ne découvrait le message d'Alice qu'au prochain rafraîchissement de son fil…
c'est-à-dire quand il écrivait lui-même. Exactement ce que le user décrivait.

### La question difficile : où poser la sonnette ?

Le réflexe serait de sonner depuis la route qui crée le message. **C'est faux.**

Rappelons-nous le chapitre 2 : un message chiffré s'écrit en **deux temps**.

```
  temps 1              temps 2
  ───────              ───────
  POST /messages   →   POST /e2ee/enveloppes
  (la ligne)           (le texte, chiffré)

              ▲
              └── sonner ICI enverrait Bob relever… du vide.
```

Entre les deux, la ligne existe mais **son contenu n'existe pas encore**. Un avis
parti à ce moment-là enverrait Bob chercher quelque chose qui n'est pas arrivé —
et il ne serait pas rappelé une seconde fois.

**La sonnette part donc du dépôt des enveloppes**, et de lui seul. C'est le seul
instant où le message devient réellement lisible.

> ### 🎓 La leçon
>
> **Une notification doit partir de l'événement qui rend la chose DISPONIBLE,
> pas de celui qui la commence.**
>
> C'est la même règle que « prévenir après l'écriture en base, jamais avant ».
> Un avis prématuré est pire qu'un avis absent : l'absent sera rattrapé par la
> prochaine lecture, le prématuré est consommé pour rien.

### Ce que la sonnette transporte

Rien.

```json
{ "type": "e2ee_arrivee", "convId": "…", "messageId": "…" }
```

Pas de texte, pas de chiffré, pas d'aperçu. C'est un **coup de sonnette** : elle
dit « quelque chose vous attend », et le client va voir. Faire passer le contenu
par là reviendrait à défaire le chiffrement par la porte de service.

Et puisqu'elle ne porte rien, **la manquer ne coûte rien** : les enveloppes
attendent en base. La sonnette est une *accélération*, jamais l'unique voie.

### Comment l'API atteint le serveur temps réel

Ce sont **deux processus différents**. La route REST n'a aucun accès aux sockets.
Heureusement, un **pont interne** existait déjà — il servait aux salles de
réunion. Nous lui avons ajouté une seconde porte :

| porte | vise | vocabulaire admis |
|---|---|---|
| `/interne/salle/diffuser` | tous les inscrits d'une salle | `meeting_*` |
| `/interne/personnes/diffuser` | des comptes **nommés** | `e2ee_*` |

Le vocabulaire est volontairement étroit des deux côtés. Viser des personnes
nommément est plus puissant que diffuser dans une salle : la porte doit donc être
**plus étroite**, pas moins. Rien ici ne doit pouvoir fabriquer un `message`, un
`ready` ou un `error` — des trames que les clients traitent à part et qui
changeraient leur état interne.

---

## 4. Troisième défaut — le trou que personne ne cherchait

En remontant le chemin du WebSocket pour comprendre pourquoi il diffusait et pas
le REST, une évidence a sauté aux yeux.

Souvenez-vous du chapitre 2. Nous avions posé cette règle :

```ts
// src/modules/messaging/envoi.ts — creerMessage()
if (conversation?.e2eeActif === true) {
  if (params.chiffre !== true) return { ok: false, motif: "CONVERSATION_CHIFFREE" }
  if ((params.content ?? "").trim() !== "") return { ok: false, motif: "CONTENU_EN_CLAIR" }
}
```

« Rien en clair dans un fil chiffré. » Bien.

**Mais `handleSend` dans `ws-server.mjs` ne passe pas par `creerMessage`.** Il
fait son propre `prisma.message.create`. Il ne traversait donc **aucune** de ces
gardes.

```
   client ──▶ WebSocket ──▶ handleSend ──▶ prisma.message.create   ❌ aucune garde
   client ──▶ REST      ──▶ creerMessage ─▶ prisma.message.create   ✅ gardé
                             ▲
                             └── et c'est la porte que PERSONNE n'utilise.
```

Nous avions mis la serrure sur la porte de service, et laissé l'entrée
principale ouverte.

### Ce n'était pas théorique

Il suffisait qu'un client **ignore encore** que le fil est chiffré :

- le temps d'un aller-retour, à l'ouverture de la conversation ;
- ou parce que c'est le **correspondant** qui vient d'activer le chiffrement, et
  que rien ne nous l'a encore dit.

Dans ces deux cas, parfaitement ordinaires, le texte partait par le WebSocket et
s'écrivait **en clair** dans `message.content`. Exactement ce que le chiffrement
promet d'empêcher.

### La correction

```js
const filChiffre = await prisma.conversation.findUnique({
  where: { id: convId },
  select: { e2eeActif: true },
});
if (filChiffre?.e2eeActif === true && content && content.trim() !== "") {
  ws.send(JSON.stringify({
    type: "error",
    code: "CONVERSATION_CHIFFREE",
    message: "Cette conversation est chiffree : le texte en clair est refuse.",
    tempId,
  }));
  return;
}
```

On refuse **avec un code**, pas en silence : le client sait rejouer par le chemin
chiffré quand il reçoit `CONVERSATION_CHIFFREE`. Se taire laisserait sa bulle
tourner indéfiniment.

> ### 🎓 La leçon — la plus importante du chapitre
>
> **Une règle de sécurité vaut ce que vaut le chemin le moins gardé.**
>
> Ce n'est pas une question de vigilance. C'est une question de **structure** :
> tant que deux chemins écrivent dans la même table, la règle doit vivre à
> l'endroit qu'ils partagent — ou être répétée sur chacun, ce qui veut dire
> qu'un jour on en oubliera un.
>
> Et pour trouver ce genre de trou, il n'y a pas de recette magique. Il y a une
> question à se poser systématiquement :
>
> **« Quels sont TOUS les chemins qui écrivent ici ? »**
>
> Nous ne nous l'étions pas posée. Nous l'avions posée à la table (`message`), pas
> aux **écritures**.

---

## 5. Le défaut caché du poste de développement

En testant le pont, un message est apparu au démarrage :

```
[pont] ecouteur interne en erreur: listen EACCES: permission denied
       C:\Users\…\backend-alanya\.ws-interne.sock
```

Le pont interne utilise une **socket de fichier** — un fichier spécial par lequel
deux processus de la même machine se parlent, sans ouvrir de port ni partager de
secret. C'est élégant, et c'est du monde POSIX.

**Windows n'en a pas.** Node y attend un *tuyau nommé* (`\\.\pipe\…`).

Conséquence : **le pont interne n'avait jamais fonctionné sur un poste de
développement.** En silence, puisqu'il a le droit d'être absent (`false` est un
cas ordinaire, pas une erreur). Tout ce qu'il porte — les rafraîchissements de
salle de réunion, et maintenant notre sonnette — marchait sur le VPS et pas en
local.

C'est la pire des situations : **on ne peut pas tester ce qu'on livre.**

La correction tient en trois lignes, des deux côtés du pont :

```js
const PONT_SOCKET =
  process.env.WS_INTERNAL_SOCKET ||
  (process.platform === "win32"
    ? String.raw`\\.\pipe\alanya-ws-interne`
    : path.join(process.cwd(), ".ws-interne.sock"));
```

Et au démarrage, enfin :

```
[pont] Ecouteur interne a l'ecoute sur \\.\pipe\alanya-ws-interne (tuyau nomme)
```

> ### ⚠️ À savoir
>
> Un tuyau nommé **n'a pas de permissions de fichier**. La socket POSIX est en
> `0600` : seul son propriétaire peut l'ouvrir, et c'est ce qui remplace le
> secret partagé. Le tuyau, lui, est accessible aux autres sessions de la
> machine.
>
> C'est acceptable sur un poste de développement. C'est une raison de plus pour
> que la **production reste sous Linux**.

> ### 🎓 La leçon
>
> **Un mécanisme qui a le droit d'échouer en silence finit par échouer en
> silence.**
>
> Le pont est conçu pour ne jamais casser l'action qu'il accompagne — c'est la
> bonne décision. Mais « ne jamais casser » et « ne jamais se signaler » sont
> deux choses différentes. Ici, une ligne d'erreur existait bien au démarrage ;
> personne ne l'avait lue, parce que rien n'en dépendait visiblement.

---

## 6. Ce que nous avons prouvé, et comment

Pas de « ça devrait marcher ». Deux bancs écrits pour l'occasion :

**La sonnette sonne-t-elle ?**
Bob ouvre une socket et **ne demande rien**. Alice dépose une enveloppe par la
route REST. On attend 4 secondes.

```
dépôt → HTTP 201 {"deposees":1}
✅ SONNETTE REÇUE : {"convId":"98041c9d…","messageId":null,"type":"e2ee_arrivee"}
```

**Le clair est-il vraiment refusé ?**
On envoie un texte en clair **par le WebSocket**, d'abord sur un fil chiffré,
puis sur un fil ordinaire.

```
✅ fil CHIFFRE   : le clair est refuse  → {"type":"error","code":"CONVERSATION_CHIFFREE"…}
✅ fil ORDINAIRE : le clair passe toujours → {"type":"message","message":{…}}
```

Le second essai compte autant que le premier : une garde qui refuse *tout* n'est
pas une garde, c'est une panne.

Et les deux bancs existants restent verts :

```
════ TOUT EST VERT ════                  (banc backend, 32 contrôles)
════ MODULES WEB : TOUT EST VERT ════    (banc des modules navigateur)
```

---

## 7. Le tableau de bord, à jour

| | état |
|---|---|
| X3DH + Double Ratchet, web | ✅ |
| Périmètre (personnel ↔ personnel seulement) | ✅ |
| Bannière « à partir d'ici, chiffré » | ✅ |
| Avertissement de changement de clé | ✅ |
| Identités mortes (balayage 30 j + retrait à la déconnexion) | ✅ |
| Publication des clés à la connexion | ✅ |
| Refus du clair — chemin REST | ✅ |
| **Refus du clair — chemin WebSocket** | ✅ **(ce chapitre)** |
| **Remise instantanée** | ✅ **(ce chapitre)** |
| **Pont interne utilisable en local** | ✅ **(ce chapitre)** |
| Chiffrement des médias | ⏸️ remis, décision du user |
| Coffre IndexedDB chiffré | ⏳ dette du chapitre 1 |
| Comparaison des codes de sécurité | ⏳ à faire |
| Groupes (Sender Keys) | ⛔ hors périmètre |
| Client mobile | ⏳ après validation du web |

---

## 8. Ce qu'il faut retenir de ce chapitre

Trois règles, dans l'ordre de leur importance :

1. **Une règle de sécurité vaut ce que vaut le chemin le moins gardé.**
   Demandez-vous toujours : *quels sont tous les chemins qui écrivent ici ?*

2. **Une notification part de ce qui rend la chose disponible**, pas de ce qui la
   commence. Un avis prématuré est pire qu'un avis absent.

3. **Une mise à jour ne doit jamais faire oublier.** « La plus récente gagne »
   est faux dès que la plus récente en sait moins.

Et une remarque de méthode, qui vaut pour la suite : **les trois défauts de ce
chapitre viennent d'une seule phrase du user.** Il n'a pas décrit une cause, il a
décrit ce qu'il voyait — « le message devient vide », « ça n'arrive pas tout de
suite ». C'est en prenant chaque mot au sérieux, séparément, qu'on est remonté
jusqu'à un trou de sécurité que personne ne cherchait.

---

## 9. La suite

Le chiffrement web est maintenant **complet et instantané**. Les prochaines
étapes, dans l'ordre :

1. **Le test à la main**, par le user, dans deux navigateurs. Rien ne remplace
   ça — les trois défauts de ce chapitre en viennent.
2. **Les codes de sécurité** : permettre à Alice et Bob de comparer leurs
   empreintes, pour détecter un serveur qui aurait menti.
3. **Le coffre chiffré**, qui refermera la dette du chapitre 1.
4. **Le client mobile**, une fois le web validé en usage réel.
