# Chapitre 14 — La longueur de la liste

> **Où nous en sommes.** L'archive chiffrée a trois serrures. L'une d'elles, la
> clé de récupération, est la seule qui survit à un mot de passe oublié — et la
> seule, avec le trousseau, censée tenir face à un serveur compromis. On l'a
> mesurée : elle ne tenait pas.
>
> Web `cad9287`, `95e43dd` — mobile `f863107`, `e33fe67`.

---

## 1. Combien vaut une clé de douze mots ?

Tout dépend de la liste dans laquelle on les tire :

```
  bits = nombre de mots × log2(taille de la liste)

  12 × log2(32)    = 12 × 5  =  60 bits    ← ce qu'on avait
  12 × log2(2048)  = 12 × 11 = 132 bits    ← ce qu'on a
```

Et cette serrure n'est **pas étirée** : PBKDF2, une seule itération. C'est
voulu — étirer ne sert qu'à ralentir la devinette d'un secret humain. Mais cela
veut dire que la taille du secret est **sa seule protection**.

Qui peut essayer ? Quiconque détient la clé enveloppée, son sel et son IV :
c'est-à-dire **le serveur**, ou quiconque en vole une copie. AES-GCM lui dit
lui-même quand il a trouvé (l'étiquette d'authentification passe).

2^60 essais d'un HMAC : quelques jours sur une ferme de cartes graphiques
louée. 2^132 : hors de portée de toute l'humanité.

---

## 2. Le raisonnement qui s'était trompé de levier

Le code disait :

> *« Les porter à 128 bits ferait vingt-quatre mots à recopier, et c'est le
> papier perdu qui deviendrait le vrai risque. »*

L'arithmétique était juste **pour une liste de 32 mots** (5 bits par mot).
Mais le levier n'était pas le nombre de mots — c'était la **taille de la
liste**. Avec 2 048 mots, douze mots suffisent pour 132 bits.

> ⚠️ **Un compromis bien argumenté peut reposer sur une variable qu'on n'a pas
> pensé à bouger.** Avant d'accepter « c'est le prix », demandez quels
> paramètres fixent ce prix.

Un second commentaire, dans le code mobile, affirmait **« 256 bits tirés au
sort »** pour cette même clé. Il justifiait l'itération unique par un chiffre
faux. Motif ⑤ du registre, encore.

---

## 3. D'où vient la liste

La liste française **BIP39** (celle des portefeuilles Bitcoin), accents
retirés. Elle a été conçue pour rester sans doublon une fois les accents
ôtés — on l'a vérifié plutôt que de le croire : 2 048 mots distincts, de 5 à 8
lettres, `a-z` seulement. Son empreinte SHA-256 est notée dans l'en-tête du
fichier.

⚠️ **2 048 = 2^11, et ce n'est pas un détail.** Le tirage fait
`aléa_32_bits % 2048`. Comme 2^32 est un multiple exact de 2 048, aucun mot
n'est favorisé. Une liste de 2 000 mots ferait sortir les premiers plus
souvent, et l'entropie annoncée serait fausse.

---

## 4. Ce qui ne casse pas

Les clés de 32 mots déjà distribuées **s'ouvrent toujours**. Une serrure dérive
sa clé du **texte** saisi, jamais d'une position dans une liste. Les bancs le
vérifient avec une clé de l'ancien format, des deux côtés.

Mais elles restent faibles. D'où le bouton **« Remplacer ma clé de
récupération »** : l'écran ne proposait la clé que s'il n'y en avait pas
encore — un titulaire de clé faible n'avait aucun moyen de la renforcer. Le
serveur fait un `upsert` sur (compte, type) : la nouvelle serrure **remplace**
l'ancienne, qui cesse d'ouvrir.

---

## 5. Le bug que le test a attrapé avant nous

En réécrivant la normalisation mobile par script, une barre oblique inverse a
disparu :

```dart
.split(RegExp(r'\s+'))   // voulu : découper sur les espaces
.split(RegExp(r's+'))    // écrit : découper sur la LETTRE « s »
```

`flutter analyze` : aucune remarque — c'est une expression régulière valide.
Toute clé contenant un « s » aurait été altérée avant dérivation, et la
récupération aurait échoué **sans rien dire**, le jour où quelqu'un en aurait
eu besoin.

Le test neuf l'a attrapé avant le premier commit. Un test dédié le garde
désormais : 200 clés tirées, passées en majuscules, doivent ressortir
**intactes** de la normalisation.

> 🔴 **Une fonction de normalisation doit être éprouvée sur ce qu'elle
> normalise vraiment** — des clés réellement tirées —, pas seulement sur
> l'exemple sale qu'on avait en tête en l'écrivant.

---

## 6. À retenir

| Ce qu'on croyait | Ce qui était vrai |
|---|---|
| « 128 bits = 24 mots » | 12 mots suffisent, avec la bonne **liste** |
| « Ce secret fait 256 bits » (commentaire) | Il en faisait **60** |
| « Changer de liste casse les anciennes clés » | La serrure dérive du **texte** |
| « Une regex qui compile est juste » | `r's+'` compile, et détruit la clé |

> 🔴 **Un secret non étiré ne vaut que son entropie. Calculez-la, écrivez le
> calcul à côté du code, et vérifiez-le par un test.**
