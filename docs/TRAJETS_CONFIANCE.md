# Trajets de confiance — dossier de conception UI/UX

> **Périmètre** : conception produit, parcours et maquettes. Cette branche ne
> modifie pas le backend ni les dépôts Flutter/Admin. Les contrats techniques
> proposés ci-dessous servent de base à la prochaine phase d'implémentation.
>
> **Maquettes** :
> - `docs/maquettes/trajets-confiance.html` — planches UI principales ;
> - `docs/maquettes/trajets-confiance-workflow.html` — workflow complet,
>   cliquable, avec tous les états intermédiaires.
>
> Date : 9 août 2026.

## 1. Comprendre l'existant

Le dépôt Flutter Talky possède déjà un partage de position ponctuel :
`geolocator`, `flutter_map`, OpenStreetMap, `LocationPayload` et un message
`type = 5`. Cette solution est pertinente pour envoyer **un point** dans une
conversation : elle est simple, lisible et n'upload aucun média.

Elle ne doit pas devenir le mécanisme du temps réel : chaque point serait un
message, polluerait la conversation, déclencherait les pipelines d'accusé et
de push, et rendrait la rétention impossible à expliquer à l'utilisateur.

### Direction proposée

- conserver `type = 5` pour le point ponctuel ;
- concevoir un objet métier séparé : **Trajet de confiance** ;
- afficher le suivi dans un écran dédié, pas dans le fil de discussion ;
- utiliser le cercle système `Confiance`, limité à cinq membres, comme unique
  audience par défaut ;
- afficher un état explicite de fraîcheur de la position ;
- préparer Socket.IO pour le live et REST pour le rattrapage, sans figer ici
  l'implémentation serveur.

Le dépôt Alanya Admin comporte déjà une rubrique **Géolocalisation** orientée
statistiques/IP. Elle ne doit pas être confondue avec une trace GPS privée.
La maquette inclut une future vue **Incidents** séparée et soumise à un rôle
renforcé.

## 2. Promesse produit

> **« Pendant un trajet, les personnes que j'ai choisies savent où je suis.
> Si je n'arrive pas à confirmer, elles savent quoi faire. »**

Ce n'est ni un outil de surveillance permanente, ni une application de secours
public. Le produit doit donc être rassurant avant le départ, discret pendant le
trajet, très direct au moment de confirmer et opérable sans ambiguïté en cas
d'alerte.

### Décisions UX structurantes

1. **Consentement avant le live** : le cercle, la destination, l'ETA et la
   conséquence d'une absence de réponse sont visibles avant `Démarrer le suivi`.
2. **Snapshot de l'audience** : les membres présents dans Confiance au départ
   sont les seuls destinataires de ce trajet ; le changement de liste ne change
   pas silencieusement une session en cours.
3. **Deux scénarios d'arrivée** : destination et/ou ETA peuvent déclencher le
   prompt. L'interface indique lequel a déclenché la demande.
4. **Un statut n'est jamais seulement une couleur** : `LIVE`, `Dernière
   position connue`, `À confirmer`, `Alerte SOS`, `Trajet terminé` sont écrits.
5. **Une action principale par écran** : suivre, confirmer, voir la position,
   acquitter. Le SOS reste rouge mais séparé de la navigation.

## 3. Design system retenu

Le design system persistant est dans :

```text
design-system/alanya-trajets-de-confiance/MASTER.md
```

La recherche UI/UX a orienté le choix vers **Real-time Safety / Calm under
pressure** : monitoring temps réel, états green/amber/red, indicateur de
fraîcheur, animation sobre et fallback hors ligne.

La proposition initiale de typographie Cinzel/Josefin issue de la base UI Pro
Max a été écartée : elle est élégante mais trop décorative pour une décision
urgente en français. Les maquettes utilisent **Plus Jakarta Sans** et **DM
Mono** pour les données.

### Signature : Safety Rail

Une ligne verticale relie les moments du trajet :

```text
Partagé ─── En mouvement ─── Arrivée détectée ─── Confirmé / Alerte
```

Elle sert à lire une séquence, pas à décorer. Elle est visible dans le suivi et
l'historique, tandis que la carte sombre garde le focus sur la position.

## 4. Personas et situations

### Propriétaire du trajet

Sophie rentre en taxi. Elle utilise son téléphone d'une main, parfois en
mouvement, avec une attention limitée. Elle doit pouvoir démarrer en moins de
30 secondes, comprendre qui voit sa position, confirmer avec un geste et
appuyer sur SOS sans chercher dans un menu.

### Membre de Confiance

Anna reçoit une notification alors qu'elle n'a pas ouvert Talky. Elle doit
savoir immédiatement : qui est en trajet, si la donnée est fraîche, quelle est
la destination, et quoi faire si une alerte arrive.

### Administrateur incident

Il ne voit pas les trajets ordinaires. Il voit éventuellement les incidents
SOS/absence de confirmation dans une vue séparée, avec accès justifié à la
position exacte et journalisé.

## 5. Architecture du parcours

```text
Sécurité
  ├─ Aucun trajet
  │    └─ Configurer → Consulter le cercle → Consentir → Démarrer
  ├─ Trajet actif propriétaire
  │    ├─ GPS disponible → Suivi LIVE
  │    ├─ GPS indisponible → Dernière position connue / réessayer
  │    ├─ Destination ou ETA atteinte → Prompt arrivée
  │    │    ├─ Tout va bien → Trajet terminé / cercle rassuré
  │    │    └─ SOS → Confirmation SOS → Alerte cercle
  │    ├─ Annuler → Confirmation annulation → Cercle informé
  │    └─ Perte réseau → File locale → Reconnexion / rattrapage
  └─ Historique → Détail trace → Partager / supprimer selon politique

Notification membre
  ├─ Trajet démarré → Vue membre
  ├─ Position mise à jour → Vue membre actualisée
  ├─ Absence de confirmation → Alerte ambre → Position / Appeler / Acquitter
  └─ SOS → Alerte rouge → Position / Appeler / Acquitter
```

Le prototype workflow reprend ce parcours étape par étape, avec des transitions
visuelles et les états réseau/permission qui ne doivent pas être oubliés.

## 6. Inventaire des écrans

### A. Entrée et préparation

1. **Accueil Sécurité — état vide**
   - bénéfice court ;
   - compteur Confiance `3/5` ;
   - CTA `Démarrer un trajet` ;
   - lien `Voir l'historique`.
2. **Accueil Sécurité — trajet actif**
   - carte de la session active ;
   - ETA ;
   - dernier point ;
   - CTA `Reprendre le suivi`.
3. **Configuration — type**
   - Taxi / Rendez-vous / Autre ;
   - titre facultatif ;
   - libellés en phrase, pas de champ technique.
4. **Configuration — destination**
   - carte existante réutilisée ;
   - recherche ou déplacement du pin ;
   - adresse et coordonnées confirmées.
5. **Configuration — ETA**
   - ETA facultative si destination précise ;
   - choix rapide `Dans 30 min`, `Dans 1 h`, `Choisir une heure` ;
   - message explicite : l'ETA est estimée.
6. **Configuration — cercle**
   - liste Confiance uniquement ;
   - avatars, noms, `3 personnes verront votre trajet` ;
   - aucun sélecteur d'un autre groupe dans le MVP.
7. **Consentement final**
   - récapitulatif destination / ETA / cercle ;
   - durée et arrêt manuel ;
   - scénario sans confirmation ;
   - CTA primaire `Démarrer le suivi`.

### B. Exécution

8. **Préparation GPS**
   - état `Recherche de votre position…` ;
   - bouton secondaire `Continuer sans position initiale` ;
   - ne pas bloquer le départ si le GPS met du temps.
9. **Suivi propriétaire — LIVE**
   - carte sombre ;
   - Safety Rail ;
   - chip `LIVE · mis à jour il y a 8 s` ;
   - ETA, destination, précision ;
   - CTA `Confirmer mon arrivée` ;
   - action SOS séparée.
10. **Suivi propriétaire — réseau faible**
    - badge `Connexion instable` ;
    - dernière position datée ;
    - file de points en attente ;
    - action `Réessayer`, sans masquer SOS.
11. **Permission localisation refusée**
    - bénéfice concret ;
    - `Ouvrir les réglages` ;
    - possibilité d'annuler ou de démarrer sans GPS ;
    - ne jamais afficher une fausse carte live.
12. **Vue membre — trajet actif**
    - nom du propriétaire ;
    - destination / ETA ;
    - âge et précision du point ;
    - `Voir dans Maps` ;
    - aucune action au nom du propriétaire.
13. **Notification / deep link**
    - ouverture directe sur le trajet ;
    - snapshot de rattrapage avant animation live ;
    - message si le trajet est déjà terminé.

### C. Décision et incidents

14. **Prompt d'arrivée**
    - bottom sheet, fond calme ;
    - raison : `Votre ETA est atteinte` ou `Destination détectée` ;
    - bouton plein `Tout va bien` ;
    - bouton rouge `Déclencher un SOS` ;
    - option non primaire `Me le rappeler dans 2 min`.
15. **Confirmation d'arrivée**
    - état de succès ;
    - phrase `Votre cercle est rassuré` ;
    - résumé horaire ;
    - lien vers le détail historique.
16. **Confirmation SOS**
    - seconde étape volontaire ;
    - dernière position et son âge ;
    - champ message facultatif ;
    - verbe explicite `Envoyer l'alerte SOS`.
17. **Alerte SOS — vue membre**
    - rouge sémantique + libellé `Alerte SOS` ;
    - dernière position, heure et précision ;
    - `Voir la position`, `Appeler`, `J'ai vu l'alerte` ;
    - rappel des services d'urgence locaux si nécessaire.
18. **Alerte absence de confirmation**
    - ambre, pas rouge ;
    - texte factuel `Aucune confirmation reçue` ;
    - même accès à la position ;
    - ne pas affirmer que la personne est en danger.
19. **Alerte acquittée**
    - l'acquittement est individuel ;
    - l'état montre qui a vu, sans prétendre résoudre l'incident ;
    - possibilité de revenir à la position.
20. **Trajet résolu après alerte**
    - `L'alerte a été résolue` ;
    - distinction avec une confirmation normale ;
    - conservation dans l'historique.

### D. Historique et administration

21. **Historique — filtres**
    - Tous / Terminés / Alertes ;
    - durée, type, destination, statut ;
    - entrées terminées distinctes des alertes.
22. **Détail historique**
    - trace simplifiée ;
    - Safety Rail ;
    - événements clés ;
    - dernière position et horodatage.
23. **État vide historique**
    - explication et CTA vers le premier trajet ;
    - pas de tableau vide froid.
24. **Admin — liste incidents**
    - SOS et timeouts uniquement ;
    - priorité, âge, membre(s), état d'acquittement ;
    - aucune carte GPS exacte par défaut.
25. **Admin — demande d'accès justifiée**
    - rôle requis ;
    - motif obligatoire ;
    - confirmation et audit ;
    - durée d'accès limitée.
26. **Admin — détail incident**
    - dernière position / trace uniquement après autorisation ;
    - journal de consultation ;
    - aucune exposition dans la géolocalisation statistique générale.

## 7. Machine d'état produit

```text
ACTIVE
  ├─ arrivée détectée → PENDING_CONFIRMATION
  ├─ confirmation manuelle → COMPLETED / confirmed
  ├─ annulation → CANCELLED
  ├─ SOS confirmé → SOS
  └─ durée maximale → TIMEOUT / expired

PENDING_CONFIRMATION
  ├─ Tout va bien → COMPLETED / confirmed
  ├─ SOS → SOS
  ├─ Annuler → CANCELLED
  └─ délai dépassé → TIMEOUT / no_confirmation

SOS
  ├─ nouvelles positions possibles
  └─ Je vais bien / résolution → COMPLETED / sos_resolved

TIMEOUT
  └─ propriétaire retrouvé → COMPLETED / alert_resolved
```

Les maquettes montrent les transitions, pas seulement les écrans heureux. La
conception finale devra conserver ces états même si le transport Socket.IO ou
le GPS est momentanément indisponible.

## 8. Modèle d'information proposé

Le futur modèle doit rester indépendant des messages de chat :

```text
SafetyTrip
  id
  owner
  purpose: taxi | rendezvous | other
  title
  destination { name, address, lat, lng, radius }
  eta
  status
  confirmationReason
  startedAt / closedAt
  closeReason
  lastLocation

SafetyTripAudience
  tripId
  memberId
  invitedAt
  firstViewedAt / lastViewedAt
  alertedAt / acknowledgedAt

SafetyTripPoint
  tripId
  clientSequence
  lat / lng
  accuracy / speed / heading
  recordedAt / receivedAt

SafetyTripEvent
  tripId
  type
  actor
  createdAt
  metadata
```

La liste Confiance fournit l'audience initiale, mais le trajet conserve un
snapshot afin de garantir la cohérence historique. Un blocage ultérieur doit
révoquer l'accès futur sans réécrire l'historique du propriétaire.

## 9. Contrat d'intégration à préparer

### Frontend Flutter

- ajouter un modèle `SafetyTrip` hors `Message` ;
- ajouter un cache Drift et une outbox de points, avec `clientSequence` ;
- ajouter les événements Socket.IO `trip:*` ;
- recharger `/active` au retour au premier plan et après reconnexion ;
- utiliser des routes typées et des arguments explicites ;
- respecter les safe areas, les zones tactiles de 44/48 dp, Dynamic Type et
  reduced motion ;
- Android : parcours pédagogique puis service foreground pour le suivi ;
- iOS : `UIBackgroundModes/location` et permission « toujours » expliquée ;
- afficher `Dernière position connue` si le point est trop ancien.

### Notifications

Les payloads devront contenir au minimum :

```text
type, tripId, ownerId, status, destination, etaAt,
lastLat, lastLng, lastLocationAt, accuracy, alertReason
```

Au tap, la notification doit ouvrir le détail du trajet et non une conversation.
Les événements doivent être dédupliqués par `tripId + état + eventId`.

### Admin

Créer une page séparée de la géolocalisation IP :

- par défaut, aucune trace GPS des trajets ordinaires ;
- incidents SOS/timeout uniquement ;
- accès à la position exacte soumis à rôle, motif et audit ;
- rétention proposée : trace détaillée 30 jours, métadonnées 12 mois, à valider
  juridiquement et produit.

## 10. Recette UX

### Avant départ

- la personne sait qui voit sa position ;
- destination et ETA sont compréhensibles ;
- le texte de non-confirmation est lu avant le départ ;
- le cercle Confiance est limité à cinq et l'état `3/5` est évident.

### Pendant le trajet

- le propriétaire peut confirmer en une action ;
- le membre distingue `LIVE` de `Dernière position connue` ;
- une position a toujours un âge et une précision ;
- la carte n'est jamais la seule source de statut ;
- une coupure réseau est visible mais ne supprime pas SOS.

### En alerte

- SOS et absence de confirmation sont visuellement distincts ;
- l'alerte ne disparaît pas sur un simple retour arrière ;
- le membre peut voir la position, appeler et acquitter ;
- l'acquittement ne transforme pas automatiquement l'incident en succès ;
- le propriétaire peut résoudre une alerte après reconnexion.

### Qualité visuelle

- 375 px portrait, grand téléphone, tablette et paysage ;
- clair et sombre ;
- contraste 4.5:1 ;
- contrôles minimum 44/48 px ;
- icônes vectorielles cohérentes, jamais emoji structurels ;
- états focus/pressed/disabled ;
- animation 150–300 ms et mode réduit ;
- aucun CTA fixe sous la zone de geste système.

## 11. Hors périmètre de cette phase

- migration SQL ou contrôleur backend ;
- branchement réel de Socket.IO ;
- code Flutter de localisation en arrière-plan ;
- notification FCM en production ;
- page admin production et gestion RBAC ;
- géocodage inverse serveur ;
- intervention directe des services d'urgence.

La prochaine phase pourra transformer ce dossier et les écrans en tickets
Flutter, backend et admin séparés, avec un premier MVP limité à : démarrer,
suivre, confirmer, SOS, timeout et historique.
