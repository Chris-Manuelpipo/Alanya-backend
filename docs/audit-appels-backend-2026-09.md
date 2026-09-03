# Appels — versant serveur du chantier (08–09/2026)

Versant serveur du chantier consigné dans
[`Alanya/docs/audit-appels-2026-09.md`](../../Alanya/docs/audit-appels-2026-09.md), qui porte
le contexte, les symptômes de terrain et la méthode. Ce document ne couvre que ce dépôt.

Branche `main`, huit commits.

---

## Les accusés de réception

Deux handlers émettaient dans le vide sans que l'émetteur puisse le savoir. Un socket peut
être mort sans que rien ne le dise : Socket.IO ne le constate qu'au bout de son ping — 25 s
d'intervalle, 20 s de patience.

**`end_call`** (`f3b1355`). Le raccrochage n'accusait rien, et un socket non authentifié
était traité par un `return` muet : le client croyait son raccrochage transmis alors qu'il
venait d'être jeté. Toutes les sorties accusent désormais — favorablement pour un
raccrochage traité, y compris la sortie « déjà hors appel » qui rend le rejeu sûr, et
explicitement défavorablement pour un socket non authentifié.

**`answer_call`** (`79f7920`). C'est pourtant le seul message que l'appelant attend. Les
refus explicites — `CALL_ID_REQUIRED`, `CALL_NOT_RINGING`, `CALL_INVALID_STATE` — se soldent
négativement, pour que le client cesse de se déclarer connecté sur une réponse écartée.

L'accusé est optionnel dans les deux cas : le parc installé n'en envoie pas et continue de
fonctionner à l'identique.

> **Ordre de déploiement.** Le serveur doit partir **avant** l'APK. Face à un serveur sans
> ces correctifs, `answerCall` n'obtient aucun accusé, reconstruit son socket, réessaie, et
> démonte l'appel. Tous les décrochages mourraient au bout de six secondes environ.

---

## Le chemin de groupe

C'était le moins couvert des trois chemins d'appel, et il l'était mal.

### Un refus de groupe réécrivait le dernier appel à deux (`6952ef3`)

Le push `group_call` ne porte aucun `callId` : l'entrée CallKit prend le `roomId`, de la
forme `group_<conv>_<ms>`. À l'expiration ou au refus, le client postait sur `/calls/reject`.
Côté serveur, `toInt("group_…")` rend `null`, la garde anti-refus-tardif était sautée, et le
repli SQL sélectionnait **le dernier appel 1-à-1 entre ces deux comptes** pour le passer à
`status = 2`. `finalizeCallAndNotify` remontait ensuite leur conversation en tête de liste
avec un aperçu daté de maintenant.

Un appel abouti de la veille devenait « Rejeté » chez les deux, sans que personne n'ait rien
fait d'autre qu'ignorer une invitation. Le repli ne s'applique plus quand l'indice fourni
n'est pas numérique.

### La fin d'un appel de groupe n'atteignait pas les invités hors ligne (`feb74e2`)

`end_group_call` et le départ du dernier participant ne diffusaient qu'à la salle socket
`group_<id>`. Or un invité dont l'application est fermée n'y est jamais entré : il n'a été
joint que par `notifyGroupCall`. Rien ne retirait son entrée CallKit, et son téléphone
sonnait les quarante secondes complètes — écran de verrouillage compris — pour un appel que
tout le monde avait quitté. À l'expiration, l'entrée retirée déclenchait en plus le faux
refus décrit ci-dessus.

Le 1-à-1 et la conférence poussent bien un `call_ended` dans ce cas ; le groupe était le seul
à ne pas le faire. Il manquait la primitive : `callDeviceOwnership.listUsers(key, state)`,
implémentée des deux côtés — repli mémoire et Redis.

### Une invitation ne consultait aucun état d'occupation (`feb74e2`)

`call_user` protège sa cible depuis toujours et lui émet `call_busy`. `create_group_call`
sonnait chez tout le monde : l'invitation arrivait en plein écran, sonnerie comprise,
par-dessus une conversation en cours — `isApplicationForeground` rend faux dès que le verrou
d'écran est posé, c'est-à-dire l'état normal d'un appel audio, écran éteint.

### Un appel de groupe n'occupait pas son participant (`1825132`)

Le trou jouait dans les deux sens. Ni `create_group_call` ni `join_group_call` n'écrivaient
dans `callState` : un utilisateur en pleine conversation de groupe était invisible à
`isBusyForNewCall`, et un appel à deux lui arrivait par-dessus.

L'inscrire sous `in_call` aurait fait dérailler tout ce qui lit cet état. D'où un **statut
distinct**, `in_group`, et la vérification qui va avec : les seize consommateurs de
`callState` ont été relus un par un, quatorze testent explicitement `ringing` ou `in_call` —
la grâce de déconnexion de `presence.js`, l'appariement d'`answer_call`, la sortie anticipée
d'`end_call`, la garde de refus tardif. Un `in_group` leur reste invisible.

Deux gardes complètent : `setInGroup` refuse d'écraser un appel à deux en cours — celui-là
porte un pair et un identifiant dont tout dépend — et `clearGroup` ne retire qu'une
inscription de groupe, là où un `clear` nu effacerait un appel commencé entre-temps.

---

## File de tâches et notifications

**`hasJob()` comptait les jobs définitivement en échec comme armés.** La requête ne filtrait
pas `failed_at IS NULL`, contrairement à celle de `processOneJob`. Une grâce de déconnexion
morte laissait donc l'utilisateur « occupé » jusqu'à la purge de rétention — trente jours.

**`processOneJob` rendait au pool une connexion en transaction ouverte** (`f15659a`). La
transaction n'entoure que la prise du verrou, validée avant l'exécution du handler. Mais si
le SELECT, l'UPDATE ou le commit levait — coupure MySQL, verrou expiré, pool saturé — aucun
ROLLBACK n'était fait, et le prochain emprunteur héritait de verrous de lignes qui n'étaient
pas les siens. Tous les délais d'appel passent par cette file. La prise de verrou est
extraite dans `_prendreUnJob` avec un rollback garanti, le solde d'un échec dans
`_solderEchec`.

**Le push `call_ended` partait en priorité normale avec 24 h de TTL**, là où le push d'appel
part en priorité haute avec 45 s — `CALL_TYPES` ne le contenait pas. Un data message FCM en
priorité normale est justement celui que Doze diffère : l'ordre d'arrêt arrivait après la
sonnerie, ou des heures plus tard.

**Une cible sans identifiant d'appareil ne recevait jamais l'ordre d'arrêt.** La garde qui
écarte les cibles ambiguës s'appliquait même sans exclusion demandée, privant les comptes
anciens — ceux dont `device_ID` vaut `INDEFINI` — du `call_ended`. La décision vit désormais
dans `callEndedTargets.js`, une seule fois, et son test importe la vraie fonction au lieu de
la réimplémenter.

---

## Vérification

- `npm run test:calls` — **17 fichiers**, verts sur deux passages consécutifs.
- `npm run test:concurrency` — exige un vrai Redis (`REDIS_URL`), aucun skip silencieux.

> **Instabilité connue.** `conferenceRejectRouting.test.js` tombe par intermittence sur une
> connexion fermée par le serveur MySQL distant. Ce n'est pas une régression : relancer.
> Toujours vérifier deux passages avant de conclure à un échec.

## Ce qui reste ouvert

- `registerToken` n'est jamais appelé côté client : la colonne `platform` de l'appareil est
  réécrite à `unknown` à chaque enregistrement de jeton.
- La conversation active ne peut pas être effacée côté serveur — le client envoie `null`,
  que le backend interprète comme « ne change rien ». Il continue donc d'y supprimer les
  notifications après que l'utilisateur a quitté la conversation.
- Le fan-out des pushs d'appel est sériel, là où celui des messages est parallélisé par lots :
  les invités d'un groupe sonnent en escalier, et le dernier de la liste dispose
  mécaniquement de moins de temps pour décrocher que le premier.

## Sur le fichier `audit-second-anneau-non-verifie.md`

Ce fichier (63 entrées, 28/08, hors dépôt) est **largement périmé** — triage fait le 02/09
contre le code courant. La quasi-totalité de sa strate « casse » est corrigée, et beaucoup
d'entrées sont des doublons les unes des autres : le TTL de `call_ended` y figure trois fois,
`hasJob` quatre fois, la grâce hors worker quatre fois. Ne pas le relire comme une liste de
bugs ouverts.

Une de ses trouvailles est **fausse** et bien argumentée : `dismissIncomingUiSilently` ne
déclenche pas de refus sur iOS — la garde qui sort hors Android est correcte, iOS n'a aucun
listener `ACTIVE_CALLS` à tromper.
