# Chapitre 18 — Ce que le silence cachait

> **Où nous en sommes.** 28/09/2026, après-midi. Trois signalements du user,
> sans lien apparent : l'état d'un message qui ne bouge plus, des messages
> chiffrés vides après une mise à jour, un nouvel appareil qui ne retrouve
> pas son historique. Trois défauts, une seule famille : **quelque chose
> échouait, et rien ne le disait.**
>
> Backend `d443124`, `5c1c7e0` — mobile `e1be61f`, `9e4765e`, `9500b7c`,
> `cef8862` — web `9e06464`, `7af81a9`.

---

## 1. L'état qui redescendait

Un message part. Le serveur fait trois choses, **dans cet ordre** :

1. il prévient le destinataire (« une enveloppe t'attend ») ;
2. il attend Google, pour la notification push ;
3. il répond à l'expéditeur (« c'est enregistré, voici l'identifiant »).

Si le destinataire a la conversation ouverte, il lit **pendant l'étape 2**. Son
« lu » arrive chez l'expéditeur, dont la bulle passe en bleu… puis l'étape 3
arrive, et le client **remplace** la bulle provisoire par la version du serveur :
« envoyé ». Le destinataire a déjà lu : plus rien ne corrigera.

| instant | bulle de l'expéditeur |
|---|---|
| envoi | ⏱ en attente |
| « lu » reçu (étape 2) | ✓✓ bleu |
| réponse du serveur (étape 3) | ✓ **redescendu, pour toujours** |

**La règle qui répare** : un état ne redescend jamais. `statutFusionne` (mobile
et web, deux jumeaux) garde le plus avancé des deux.

> ⚠️ **Et un état peut précéder son message.** Le « distribué » (section 2)
> vise l'identifiant du serveur, que la bulle ne porte pas encore. On le met
> de côté (`_statutsEnAvance`, `statutsEnAvanceRef`) et on l'applique au
> remplacement.

> 🎯 **Leçon.** Quand deux réponses peuvent arriver dans n'importe quel ordre,
> « la dernière arrivée gagne » est presque toujours faux. Il faut une règle
> d'ordre sur la **valeur**, pas sur le moment.

---

## 2. « Distribué », le moment juste

Un message ordinaire passe « distribué » à l'envoi si le destinataire est en
ligne. Un message chiffré, créé par une route REST, **ne passait jamais** :
coche simple jusqu'à la lecture.

Où poser « distribué » ? Pas au dépôt de l'enveloppe : un dépôt ne prouve rien,
le destinataire peut être hors ligne des jours. **À l'acquittement** : c'est la
preuve qu'un de ses appareils a relevé l'enveloppe.

Deux gardes, éprouvées par `scripts/e2ee-distribue-banc.mjs` :

- `SENT` seulement : un message « lu » ne redescend pas (encore la section 1) ;
- jamais nos propres messages : les copies vers nos autres appareils ne sont
  pas une distribution.

Le banc a d'abord tourné **sur l'ancien code** : il a échoué (message resté
« envoyé »). Puis sur le nouveau : vert. Un test qui n'a jamais été rouge ne
prouve pas qu'il sait voir le défaut.

---

## 3. Le rattrapage qui ne s'exécutait jamais

À l'ouverture d'une conversation, l'écran mobile lançait deux tâches, sans
attendre ni l'une ni l'autre :

```dart
unawaited(_lireEtatChiffrement());   // demande au serveur : ce fil est-il chiffré ?
unawaited(_completerParArchive());   // if (!_filChiffre) return; …
```

La seconde teste `_filChiffre` **immédiatement**. La première n'a pas encore sa
réponse : `_filChiffre` vaut `false`. La seconde sort. **À chaque ouverture.**
Le code existait, était commenté, relu — et n'avait jamais tourné.

La correction ne consiste pas à ajouter un `await` : elle consiste à ne plus
dépendre de cette réponse. Chaque message dit lui-même s'il est chiffré
(`chiffre`, posé par le serveur).

> 🎯 **Leçon.** Deux tâches lancées « en parallèle » dont l'une lit ce que
> l'autre écrit ne sont pas parallèles : elles sont dans le désordre.

---

## 4. La restauration qu'on ne voyait pas

Sur un nouvel appareil, la connexion lançait la restauration **en fond**, et
chaque échec était avalé : mot de passe changé depuis la création de la
sauvegarde, archive protégée par la seule clé de récupération, coupure réseau.
Trois causes différentes, un seul symptôme : rien.

La page (web) et l'écran (mobile) de restauration ne sont pas seulement une
barre de progression. Leur vrai apport est de **nommer l'issue** :

| issue | ce que ça veut dire | ce qu'on propose |
|---|---|---|
| rien à restaurer | pas d'archive, ou refusée | entrer |
| restaurée | tout va bien | entrer |
| **fermée** | ce mot de passe n'ouvre pas l'archive | la clé de récupération |
| **échec** | réseau, serveur | réessayer |

Fermée et échec **ne se confondent pas** : réessayer ne sert à rien dans le
premier cas, et tout dans le second.

> ⚠️ **Le piège trouvé en écrivant la page web.** `lireCoffre` transforme une
> panne réseau en « refusée ». C'est juste pour son usage (dans le doute, ne
> rien créer), mais la page aurait alors affiché « rien à restaurer » pendant
> une coupure. Une fonction qui avale une erreur pour une bonne raison peut
> la cacher à un appelant qui en a une autre.

Deux détails de construction :

- **Mobile** : Argon2id (64 Mio, 3 passes) tournait sur le fil de l'écran, qui
  se figeait. Il tourne maintenant dans un isolat (`compute`).
- **Le mot de passe** passe de la connexion à la page **en mémoire, une fois**,
  effacé au bout d'une minute. Ni URL, ni stockage, ni état de navigation.

---

## 5. Les pièges du banc

Le banc de la page web a échoué deux fois avant d'être juste — et c'était le
**banc** qui avait tort :

1. `toutEffacer()` marque le compte « refusé ». La première étape passait
   « rien à restaurer »… parce que la sauvegarde était refusée, pas parce
   qu'elle était vide. Un test peut réussir pour une mauvaise raison.
2. Au 10ᵉ message, `archiver` lance un dépôt **sans l'attendre**. Un `vider()`
   final trouvait le tampon vide et rendait la main avant la fin des dépôts :
   la restauration lisait une archive encore vide.

Le remède n'a pas été de relâcher les vérifications, mais d'ajouter celles qui
manquaient (« l'archive est ouverte », « une serrure est posée ») pour que le
banc dise **pourquoi** il passe.

---

## 6. À retenir

1. Un échec avalé n'est pas une erreur évitée : c'est une erreur **déplacée**
   vers l'utilisateur, sans explication.
2. Un état qui avance ne doit pas pouvoir reculer parce qu'une réponse arrive
   en retard.
3. Une tâche qui lit ce qu'une autre écrit doit l'attendre — ou ne pas en
   dépendre.
4. Un test doit avoir été rouge au moins une fois.
5. Quand un banc réussit, vérifier qu'il réussit **pour la bonne raison**.
