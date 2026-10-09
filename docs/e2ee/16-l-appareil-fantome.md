# Chapitre 16 — L'appareil fantôme

> **Où nous en sommes.** Dernier lot de la série commencée le 28/09/2026. Trois
> défauts qui ont un point commun : ils ne gênent **aucun** utilisateur
> honnête. Ils ne servent qu'à quelqu'un qui cherche une faille.
>
> Backend `64af118` — web `65a4024` — mobile `322f640`.

---

## 1. L'appareil qu'on n'a pas vu arriver

Le chiffrement de bout en bout repose sur une idée : **le serveur transporte,
il ne lit pas**. Un serveur malveillant — ou compromis — peut-il quand même
lire ?

Il ne peut pas changer la clé de Bob sans alerte : on l'a verrouillé
(chapitre 10). Mais il peut faire plus simple : **ajouter un appareil** à Bob.
Un appareil dont il détient la clé privée. Alice, qui chiffre « pour chaque
appareil de Bob », chiffre désormais aussi pour lui.

Avant ce lot, que voyait Alice ?

| cas | alerte |
|---|---|
| la clé d'un appareil connu de Bob change | ✅ oui |
| un appareil **de plus** apparaît chez Bob | ❌ **non** |

Seule la pastille « vérifié » tombait — et pour un contact jamais vérifié,
c'est-à-dire presque tous, **rien du tout**.

**Le correctif** : dans `saveIdentity`, une identité **jamais vue** pour une
adresse, alors que le même compte a **déjà** un appareil connu, pose la même
alerte qu'un changement de clé. C'est ce que fait WhatsApp : le code de
sécurité change quand le correspondant ajoute un appareil.

⚠️ **Deux exceptions, et elles comptent** :
- le **premier** appareil d'un nouveau contact n'alerte pas — il n'a rien
  rejoint ni remplacé ;
- **ses propres** appareils non plus — ils s'ajoutent de notre fait (lot 5).

### Pourquoi le mobile a demandé plus de travail

Le web lit ses clés dans une table en mémoire : savoir « Bob a-t-il déjà un
appareil connu ? » est gratuit. Le coffre sécurisé du mobile, lui, ne sait pas
énumérer ses clés sans **tout relire** — un aller-retour natif coûteux. D'où
une liste des appareils connus par correspondant, tenue à jour, et amorcée
**une seule fois** par lecture complète pour les installations antérieures —
sinon leur premier appareil de plus passerait inaperçu.

---

## 2. Vider le stock de quelqu'un d'autre

`GET /api/e2ee/cles/<compte>` consomme une pré-clé par appareil. Et **n'importe
quel compte** pouvait l'appeler, en boucle, sur n'importe qui. Deux effets :

- le stock de la victime se vide, et ses sessions suivantes s'ouvrent sans
  pré-clé unique — la sécurité d'X3DH s'en trouve réduite ;
- la route dit à un inconnu **qui chiffre**, et **depuis combien
  d'appareils**.

**Le correctif** : le paquet n'est servi qu'à qui **partage une conversation**
avec ce compte, ou au compte lui-même. Sinon, **404 « PAS_DE_CLES »** — la même
réponse qu'un compte sans clés. Un 403 aurait dit « ce compte chiffre, mais pas
pour toi ».

### Un banc qui ne prouvait rien

Premier essai : ✓ « un inconnu est éconduit (404) ». Satisfaisant… et faux. Le
**témoin** — Alice, qui parle à Bob, doit être servie — recevait **aussi**
404. Une étape précédente du banc avait retiré l'identité de Bob : tout le
monde recevait 404, et le refus de l'inconnu ne prouvait rien.

> 🔴 **C'est exactement pour cela qu'un refus n'existe jamais sans son
> témoin.** Sans Alice, on aurait livré un contrôle vert qui ne contrôlait
> rien.

Le banc demandait aussi les clés de Bob **avant** de créer leur conversation —
ce que l'application ne fait jamais. Il a été réordonné.

---

## 3. L'identité qui ne mourait jamais

Une identité est ignorée après trente jours sans relève. Mais le filtre laisse
passer `null` — une identité qui n'a **jamais** relevé — pour ne pas refuser le
tout premier message. Or `derniere_releve` n'était posée **qu'**à la relève.

Un navigateur qui publie ses clés puis disparaît avant sa première relève
restait donc servi **pour toujours** : il consommait des pré-clés et recevait
des enveloppes que personne ne lirait.

**Le correctif** : la **publication** date l'identité aussi. Publier prouve,
autant que relever, que l'appareil existe à cet instant.

---

## 4. Ce qui reste, et qu'il faut savoir

| | |
|---|---|
| **Défaut n° 8** (index SQL recréé à chaque déploiement) | Non corrigé : la migration n'a pas pu être prouvée. Aucun compte n'a deux trousseaux aujourd'hui (vérifié en production) — le risque est latent. |
| **La déconnexion mobile ne retire pas l'identité** | Voulu : le coffre survit à la déconnexion et l'identité reste la même à la reconnexion. La retirer forcerait une republication, et une alerte chez chaque correspondant. |
| **Relecture extérieure** (6.5 du plan) | Toujours à faire. Tout ceci a été écrit et relu par les deux mêmes. |

---

## 5. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « Un changement de clé est la seule attaque visible » | **Ajouter** un appareil ne changeait rien à l'écran |
| « Une lecture ne coûte rien » | Elle vidait le stock de **quelqu'un d'autre** |
| « `null` veut dire : pas encore relevé » | Il voulait aussi dire : **jamais**, pour toujours |
| « Le refus est vert, donc il marche » | Tout le monde était refusé — le **témoin** l'a vu |

> 🔴 **Un attaquant ne passe pas par la porte que l'on garde.** Pour chaque
> garde, demandez-vous : « et si, au lieu de forcer la serrure, on ajoutait une
> porte ? »
