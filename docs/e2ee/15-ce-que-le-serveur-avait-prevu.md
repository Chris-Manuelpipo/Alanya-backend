# Chapitre 15 — Ce que le serveur avait prévu

> **Où nous en sommes.** Trois défauts de taille moyenne, et un point commun :
> dans deux cas sur trois, le serveur avait **prévu** le bon comportement, et
> aucun client ne s'en servait — ou l'inverse.
>
> Backend `4a981ae`, `14d9cf7` — web `1cd4e6f`, `5d3a86b` — mobile `63e8d74`,
> `77db0f4`.

---

## 1. Deux notifications pour un message

Le dépôt des enveloppes appelait `pushNewMessage` dans **deux blocs**
successifs, écrits le même jour, chacun avec son commentaire convaincant. Chaque
destinataire recevait deux notifications par message chiffré.

⚠️ **Cette preuve-là n'est que de lecture.** En local, l'envoi push est inerte
(pas de compte Firebase) : on a vu les deux appels, on n'a pas compté les
notifications. Le chapitre le dit, le commit aussi.

> ⚠️ **Deux blocs qui font la même chose avec deux commentaires différents,
> c'est une relecture qui a été faite en lisant les commentaires.**

---

## 2. Mes messages, sur mes autres appareils

Le serveur l'avait prévu : la sonnette `e2ee_arrivee` prévient aussi
l'expéditeur, « pour ses autres appareils ». Mais **aucun client ne chiffrait
pour ses propres autres appareils**. Un message écrit sur le téléphone
n'arrivait jamais sur le navigateur du même compte — sauf plus tard, par
l'archive, si elle y était ouverte.

Le plan disait, au ticket 4.15 : *« multi-appareil simultané : rien à
écrire »*.

**Le correctif** tient en quelques lignes, des deux côtés : après les
enveloppes du correspondant, une par appareil de **mon** compte, **cet
appareil exclu** — s'ouvrir une session vers soi-même consommerait une de ses
propres pré-clés pour rien.

### Le piège du banc

Premier essai : Alice ouvre un second navigateur. Il **déconnecte** le
premier. Le serveur n'admet qu'un mobile et un navigateur par compte
(`appareilTotal`). Le banc monte ce réglage à 3 pour ses comptes de test.

Second piège, évité de justesse : si le second navigateur se connecte
**après** l'envoi, la restauration de l'archive à la connexion lui apporte le
message — et le test passe **sans rien prouver**. Il se connecte donc
**avant**.

> ⚠️ **Quand un comportement a deux chemins, le test doit fermer celui qu'il
> n'éprouve pas.** Sinon il mesure l'autre.

---

## 3. L'archive tronquée

`GET /api/e2ee/archive` rendait au plus 2 000 blocs, du plus ancien au plus
récent. Au-delà, la restauration perdait les messages **les plus récents** —
les plus précieux — et `total` valait le nombre *rendu*, pas le nombre
*existant*. Rien ne le signalait.

À 10 messages par bloc, c'est 20 000 messages : un compte actif y arrive en
quelques mois.

**Correctif** : un **curseur** (`?apres=<id>`, `suivant` en réponse), pas un
décalage. Un bloc déposé pendant la lecture décalerait toutes les pages
suivantes ; un curseur, non. Et un ordre **total** — `(createdAt, id)` — sans
quoi deux blocs de la même milliseconde n'ont pas de place définie.

Les clients suivent `suivant` jusqu'au bout, avec un plafond de tours : un
serveur qui rendrait toujours le même curseur ne doit pas faire tourner la
boucle à l'infini.

### Un reste d'étape qui a failli tromper

Premier passage du banc après correctif : **2 101** blocs relus au lieu de
2 100. La pagination marchait ; l'étape précédente avait laissé un bloc.

> ⚠️ **Un banc qui enchaîne des étapes doit remettre à zéro ce qu'il compte.**
> Sinon il mesure l'histoire du banc, pas le code.

---

## 4. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « Multi-appareil : rien à écrire » | Aucun client ne chiffrait pour ses autres appareils |
| « Le serveur rend l'archive » | Il en rendait les 2 000 **premiers** blocs |
| « `total` dit combien il y en a » | Il disait combien il en **rendait** |
| « Une notification par message » | **Deux**, écrites le même jour |

> 🔴 **Un contrat à deux côtés se vérifie des deux côtés.** Le serveur prévoyait
> la sonnette de l'expéditeur ; les clients, eux, attendaient un `suivant` que
> le serveur ne donnait pas.
