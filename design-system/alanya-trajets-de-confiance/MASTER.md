# Alanya — Trajets de confiance

## Direction retenue

**Real-time safety / calm under pressure** : une interface de sécurité personnelle
qui reste calme quand tout va bien et devient immédiatement lisible quand une
alerte apparaît. Le mobile est le produit principal ; la maquette web ne sert
qu'à présenter les états et le workflow.

Le résultat de la recherche UI Pro Max suggérait « Real-Time Monitoring » avec
une palette rouge/bleu, des états live et un mouvement standard. La typographie
Cinzel/Josefin remontée par la base était trop éditoriale et décorative pour une
situation urgente : elle est volontairement remplacée par une sans-serif
lisible et plus internationale.

## Tokens

### Couleurs

| Token | Valeur | Usage |
|---|---|---|
| `ink-950` | `#0B1324` | coque sombre, titres forts |
| `ink-900` | `#101B31` | map / surfaces de sécurité |
| `ink-700` | `#34435D` | texte secondaire sombre |
| `paper-50` | `#F6F8FC` | fond applicatif clair |
| `paper-0` | `#FFFFFF` | surfaces et cartes |
| `blue-600` | `#356DFF` | action principale, route live |
| `blue-100` | `#EAF0FF` | conteneur d'information |
| `green-600` | `#138A62` | confirmé / live rassurant |
| `green-100` | `#E5F7EF` | fond état confirmé |
| `amber-600` | `#A96000` | attente de confirmation |
| `amber-100` | `#FFF3D8` | fond avertissement |
| `coral-600` | `#C93732` | SOS / danger |
| `coral-100` | `#FFE9E7` | fond alerte |
| `line` | `#DCE3ED` | séparateurs, contours |

Les états ne reposent jamais sur la couleur seule : chaque état possède un
libellé, une icône vectorielle et une phrase explicite.

### Typographie

- **Titres et cartes** : Plus Jakarta Sans, 700/800.
- **Corps et formulaire** : Plus Jakarta Sans, 400/500.
- **Heures, coordonnées et données** : DM Mono, 500.
- Échelle mobile : 12 / 14 / 16 / 18 / 24 / 32 px.
- Corps minimum 14 px ; ligne 1.45 à 1.6 ; jamais de texte essentiel sous 12 px.

### Géométrie

- Rythme 4/8 px ; sections 24/32 px.
- Rayon carte 24 px, rayon champ 14 px, rayon bouton 14 px, pill 999 px.
- Zone tactile minimum 48 × 48 dp, 8 px entre actions voisines.
- Safe area : 16 px au-dessus du contenu fixe et 24 px au-dessus de la barre
  d'action basse.

## Signature visuelle

La **Safety Rail** : une ligne verticale discrète qui relie les moments du
trajet (`partagé → en mouvement → arrivée → confirmé/alerte`). Elle apparaît
sur l'écran propriétaire et dans le détail historique. Elle donne une lecture
séquentielle sans transformer la carte en dashboard technique.

La carte est volontairement sombre dans le suivi : le tracé bleu reste visible,
le pin de la personne est cerclé d'une aura, et la carte ne concurrence pas les
actions critiques du bottom sheet.

## Mouvement

- Entrée écran : translation verticale 12 px + opacité, 220 ms.
- Mise à jour LIVE : halo du pin 2 s, sans faire bouger la carte.
- Transition du prompt : bottom sheet 260 ms, easing `cubic-bezier(.2,0,0,1)`.
- Alerte : une seule pulsation courte du marqueur, pas de clignotement continu.
- `prefers-reduced-motion` / équivalent Flutter : supprimer halo et translation.

## Règles d'interaction

- Le CTA primaire conserve le même verbe dans tout le parcours : `Démarrer le
  suivi`, puis `Confirmer mon arrivée`.
- Le SOS est une action persistante mais toujours confirmée par une seconde
  feuille ; il ne doit jamais être voisin d'un bouton de navigation sans espace.
- L'ETA est présentée comme une information et non comme une promesse.
- Une position est toujours accompagnée de son âge : `Mis à jour il y a 8 s`.
- En cas de perte GPS : badge `Dernière position connue` + heure, jamais `LIVE`.
- Les erreurs sont proches du champ concerné et expliquent la correction.
- Les écrans d'alerte proposent d'abord la dernière position, ensuite l'appel,
  enfin l'acquittement.

## Accessibilité / recette visuelle

- Contraste texte 4.5:1 minimum ; vérifier les états amber sur fond clair.
- Tous les contrôles icon-only ont un label ; les maquettes utilisent des SVG
  cohérents plutôt que des emoji structurels.
- Vérifier 375 px portrait, grand téléphone, tablette et paysage.
- Tester dynamique de texte / taille maximale, dark mode et reduced motion.
- Aucun élément fixe ne masque la zone de geste système ou le CTA final.
