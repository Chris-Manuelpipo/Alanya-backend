# Codes d'erreur — contrat serveur ↔ application

Toute réponse HTTP 4xx/5xx porte un `code` machine stable. **C'est lui le
contrat.** Le champ `error` reste une prose lisible destinée aux journaux et aux
clients anciens : il peut être reformulé librement.

```json
{ "error": "Votre cercle de confiance est vide", "code": "TRUST_LIST_EMPTY" }
```

## Pourquoi

Avant l'audit de 09/2026, 604 réponses d'erreur existaient et 135 seulement
portaient un `code`. L'application affichait donc `error` faute de mieux : une
prose française jamais traduite, que lisaient aussi les utilisateurs en anglais
et en chinois, et où filtrait parfois un `ER_NO_SUCH_TABLE`.

## Règles

1. **Un code ne se renomme jamais.** Les clients déployés ne se mettent pas à
   jour d'un bloc ; un renommage casse ceux qui restent. Pour changer de sens,
   ajouter un code et laisser l'ancien vivre.
2. **La prose n'est pas un contrat.** Ne jamais la lire côté client pour décider
   quoi afficher — c'était précisément le défaut corrigé.
3. **Aucun message de driver ne sort.** `src/utils/apiError.js` filtre les
   `ER_*`, les traces de pile et les chemins absolus vers `INTERNAL`.
4. **Un code inconnu de l'application n'est pas une panne.** Le client retombe
   sur le statut HTTP. Le serveur peut donc ajouter des codes à son rythme.

## Usage

```js
const { fail, failInternal } = require('../utils/apiError');

if (!liste.length) {
  return fail(res, 409, 'TRUST_LIST_EMPTY', 'Cercle de confiance vide');
}

try { /* … */ } catch (e) {
  console.error('[trips] création échouée', e);   // le détail va au journal
  return failInternal(res);                        // et non à l'utilisateur
}
```

## Codes traduits par l'application

Ceux-ci ont une phrase dédiée dans
`lib/core/errors/error_presenter.dart` (application Flutter). Les autres codes
sont valides mais rendus par le repli lié au statut HTTP.

### Session et compte
| Code | Statut | Sens |
|---|---|---|
| `TOKEN_EXPIRED` | 401 | Jeton d'accès expiré |
| `TOKEN_INVALID` | 401 | Jeton illisible ou falsifié |
| `TOKEN_REQUIRED` | 401 | Aucun jeton fourni |
| `REFRESH_EXPIRED` | 401 | Jeton de rafraîchissement expiré |
| `DEVICE_REVOKED` | 401 | Appareil déconnecté à distance |
| `ACCOUNT_DELETION_PENDING` | 403 | Compte en cours de suppression |
| `REGISTER_RATE_LIMITED` | 429 | Trop de créations de compte |

### QR et appairage
| Code | Statut | Sens |
|---|---|---|
| `QR_SESSION_EXPIRED` | 410 | Code QR périmé |
| `DEVICE_NOT_OWNER` | 403 | Appareil non autorisé pour l'action |
| `ADD_ALREADY_USED` | 409 | Code d'ajout déjà consommé |
| `ADD_ME_POLICY_DENIED` | 403 | La cible refuse l'ajout par code |

### Réunions
| Code | Statut | Sens |
|---|---|---|
| `MEETING_EXPIRED` | 410 | Heure de fin dépassée |
| `MEETING_ENDED` | 410 | Terminée par l'organisateur |
| `MEETING_ORGANISER_REQUIRED` | 403 | Réservé à l'organisateur |
| `ACCOUNT_ALREADY_IN_MEETING` | 409 | Déjà présent sur un autre appareil |
| `SESSION_BUSY` | 409 | Un appel tient la session média |
| `MAX_DURATION_REACHED` | 403 | Durée maximale atteinte |

### Conversations, groupes et listes
| Code | Statut | Sens |
|---|---|---|
| `BLOCKED_BY_SENDER` | 403 | Blocage entre les deux comptes |
| `NOT_A_MEMBER` | 403 | Plus membre du groupe |
| `GROUP_ADMINS_ONLY` | 403 | Réservé aux administrateurs |
| `GROUP_OWNER_REQUIRED` | 403 | Réservé au propriétaire |
| `CONVERSATION_NOT_FOUND` | 404 | Conversation absente |
| `OFFICIAL_READONLY` | 403 | Compte officiel sans réponse |
| `LIST_MEMBER_LIMIT` | 409 | Liste pleine |
| `SYSTEM_LIST_READONLY` | 403 | Liste système non modifiable |
| `INVITE_BLOCKED` | 403 | Invitation refusée |
| `BUSINESS_ONLY` | 403 | Réservé aux comptes professionnels |

### Trajets
| Code | Statut | Sens |
|---|---|---|
| `TRUST_LIST_EMPTY` | 409 | Cercle de confiance vide |
| `TRIP_ALREADY_ACTIVE` | 409 | Un trajet est déjà en cours |
| `TRIP_TERMINAL` | 409 | Trajet déjà terminé |
| `TRIP_STILL_OPEN` | 409 | Trajet en cours à clore d'abord |
| `SOS_RATE_LIMITED` | 429 | Alerte déjà envoyée |
| `INVALID_ETA` | 400 | Heure d'arrivée invalide |
| `INVALID_DESTINATION` | 400 | Destination invalide |

### Médias
| Code | Statut | Sens |
|---|---|---|
| `MEDIA_EXPIRED` | 410 | Média purgé par rétention |
| `INVALID_EXTENSION` | 400 | Type de fichier refusé |

### Droits et divers
| Code | Statut | Sens |
|---|---|---|
| `INSUFFICIENT_ROLE` | 403 | Droits insuffisants |
| `FIELD_IMMUTABLE` | 409 | Champ non modifiable |
| `INTERNAL` | 500 | Erreur interne — aucun détail exposé |
