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

## Codes venus du socket, pas de HTTP

`SESSION_BUSY` et `ADD_ALREADY_USED` sont traduits par l'application mais
n'apparaissent dans aucune réponse HTTP : ils voyagent par `meeting:join_denied`
et par le refus d'ajout à un appel. Le garde de couverture ne les voit donc pas,
et c'est normal.

## Tous les codes HTTP émis

Le backend émet **244 codes** en réponse HTTP. 36 d'entre eux ont
une phrase dédiée dans l'application ; les 208 suivants sont valides et rendus par
le repli lié au statut. Leur donner une phrase est une amélioration, pas un
correctif — un code non traduit ne fait rien afficher de brut.

- `ACCOUNT_ALREADY_EXISTS` · `ACCOUNT_BANNED` · `ACCOUNT_REQUIRED`
- `ALREADY_EXISTS` · `APP_LINK_NOT_CONFIGURED` · `AUTH_FAILED`
- `AUTH_INTERNAL` · `AUTH_REJECTED` · `BACKUP_KEY_LAST_ACTIVE`
- `BACKUP_KEY_UNAVAILABLE` · `BILLING_ALREADY_ACTIVE` · `BILLING_NOT_ACTIVE`
- `BILLING_NOT_CONFIGURED` · `BILLING_PROVIDER_SIMULATED` · `BIO_LIMIT`
- `BLOCKS_REQUIRED` · `BROADCAST_NOT_FOUND` · `CALLER_BUSY`
- `CALLER_ID_MISMATCH` · `CALLER_ID_REQUIRED` · `CALL_ALREADY_JOINED_ON_OTHER_DEVICE`
- `CALL_BLOCKED` · `CALL_ID_REQUIRED` · `CALL_ID_UNAVAILABLE`
- `CALL_INVITE_NOT_PENDING` · `CALL_NOT_RINGING` · `CALL_REJOIN_INVALID`
- `CALL_SELF` · `CANNOT_CHANGE_OWN_ROLE` · `CANNOT_REMOVE_OWNER`
- `CANNOT_TARGET_SELF` · `CANNOT_TARGET_SUPERADMIN` · `CLIENT_ID_REQUIRED`
- `CONTACT_ALREADY_EXISTS` · `CONTACT_NOT_FOUND` · `CONTENT_REQUIRED`
- `CONVERSATION_FORBIDDEN` · `CONVERSATION_ID_REQUIRED` · `CRITERIA_REQUIRED`
- `DECISION_NOT_FOUND` · `DEVICE_ID_REQUIRED` · `DEVICE_NOT_FOUND`
- `DUPLICATE_ENTRY` · `EDIT_WINDOW_EXPIRED` · `EMAIL_REQUIRED`
- `EMAIL_TAKEN` · `EMOJI_REQUIRED` · `ESTIMATE_STALE`
- `EXPORT_EXPIRED` · `EXPORT_FAILED` · `EXPORT_NOT_FOUND`
- `FCM_TOKEN_REQUIRED` · `FEATURE_NOT_FOUND` · `FIELD_EMPTY`
- `FILE_REQUIRED` · `FILE_TOO_LARGE` · `FORBIDDEN`
- `GROUP_ADD_MEMBERS_LOCKED` · `GROUP_ADMIN_REQUIRED` · `GROUP_CALL_FULL`
- `GROUP_CALL_TOO_MANY` · `GROUP_INFO_LOCKED` · `GROUP_NOT_FOUND`
- `ID_PAYS_REQUIRED` · `ID_RECEIVER_REQUIRED` · `INSERT_LOST`
- `INVALID` · `INVALID_ACCOUNT` · `INVALID_ACCOUNT_TYPE`
- `INVALID_AGE` · `INVALID_ALANYA_ID` · `INVALID_BILLING_SETTING`
- `INVALID_BLOCK_TYPE` · `INVALID_CHANNEL` · `INVALID_CONTACT`
- `INVALID_CONVERSATION` · `INVALID_CONVERSATION_IDS` · `INVALID_COUNTRY`
- `INVALID_CREDENTIALS` · `INVALID_CRITERIA` · `INVALID_DEVICE`
- `INVALID_EMAIL` · `INVALID_FEATURE` · `INVALID_FORMAT`
- `INVALID_GENDER` · `INVALID_GIFT` · `INVALID_GRACE`
- `INVALID_GROUP` · `INVALID_IDS` · `INVALID_JOB`
- `INVALID_KID` · `INVALID_LIST` · `INVALID_MEDIA`
- `INVALID_MEETING` · `INVALID_MEMBER` · `INVALID_MESSAGE`
- `INVALID_MSG_IDS` · `INVALID_MSISDN` · `INVALID_MUTED_UNTIL`
- `INVALID_PARTICIPANT_ID` · `INVALID_PASSWORD` · `INVALID_PAYLOAD`
- `INVALID_PHONE` · `INVALID_PHONE_LENGTH` · `INVALID_PLAN`
- `INVALID_PREFERENCES` · `INVALID_QR` · `INVALID_REFERENCE`
- `INVALID_ROLE` · `INVALID_ROOM_ID` · `INVALID_SIGNATURE`
- `INVALID_TOKEN` · `INVALID_TO_USER_ID` · `INVALID_TRIP_ID`
- `INVALID_USER` · `INVALID_VERIFICATION_STATUS` · `INVALID_VERIFIED_UNTIL`
- `INVALID_VERSION` · `JOB_NOT_FOUND` · `JOB_WORKER_DOWN`
- `JOIN_ACK_INVALID` · `JOIN_ACK_MISMATCH` · `LABEL_REQUIRED`
- `LIMIT_REACHED` · `LIST_ALREADY_EXISTS` · `LIST_NOT_FOUND`
- `LIST_REQUIRED` · `MEDIA_NOT_FOUND` · `MEDIA_REQUIRED`
- `MEETING_FIELDS_REQUIRED` · `MEETING_NOT_FOUND` · `MEMBER_NOT_FOUND`
- `MESSAGE_NOT_FOUND` · `METADATA_INCOMPLETE` · `MISSING_CLIENT_ID`
- `MSG_IDS_REQUIRED` · `NOM_REQUIRED` · `NOT_A_GROUP`
- `NO_DELETION_PENDING` · `NO_FIELDS_TO_UPDATE` · `OFFICIAL_ACCOUNT_MISSING`
- `OFFICIAL_ALREADY_EXISTS` · `OFFICIAL_AVATAR_MISSING` · `OFFICIAL_BUSY`
- `OFFICIAL_NOT_BLOCKABLE` · `OFFICIAL_NOT_CALLABLE` · `OFFICIAL_NOT_DELETABLE`
- `OFFICIAL_NOT_LOGGABLE` · `OFFICIAL_NOT_PROMOTABLE` · `OFFICIAL_PHONE_TAKEN`
- `OFFICIAL_SENDER_REQUIRED` · `OTP_EXPIRED` · `OTP_INVALID`
- `OTP_NOT_REQUESTED` · `PARTICIPANT_IDS_REQUIRED` · `PASSWORD_INCORRECT`
- `PASSWORD_REQUIRED` · `PAYMENT_NOT_FOUND` · `PAYMENT_PENDING`
- `PAYMENT_PROVIDER_ERROR` · `PAYMENT_PROVIDER_UNKNOWN` · `PHONE_ALREADY_EXISTS`
- `PHONE_NOT_FOUND` · `PHONE_NOT_NUMERIC` · `PHONE_NOT_RESERVABLE`
- `PHONE_REQUIRED` · `PLAN_CODE_TAKEN` · `PLAN_NOT_FOUND`
- `POLL_TOKEN_REQUIRED` · `PROFILE_NOT_FOUND` · `PURGE_UNKNOWN`
- `QR_UNKNOWN_OR_EXPIRED` · `RATE_LIMITED` · `REASON_REQUIRED`
- `RECIPIENT_NOT_FOUND` · `REFRESH_INVALID` · `REFRESH_TOKEN_REQUIRED`
- `REPORT_NOT_FOUND` · `RESERVED_BRAND_NAME` · `ROOM_ENDED`
- `SCAN_SECRET_REQUIRED` · `SEARCH_QUERY_REQUIRED` · `SENDER_ID_REQUIRED`
- `SERVER_ERROR` · `SERVICE_UNAVAILABLE` · `SESSION_ALREADY_HANDLED`
- `SESSION_NOT_FOUND` · `SESSION_REJECTED` · `SOURCE_MSG_IDS_REQUIRED`
- `STATUS_NOT_FOUND` · `SUBSCRIPTION_REQUIRED` · `TARGET_CONVERSATION_IDS_REQUIRED`
- `TEXT_REQUIRED` · `TOKEN_TYPE_INVALID` · `TRIP_INCIDENT_LOCKED`
- `TRIP_NOT_FOUND` · `UNAUTHENTICATED` · `UNMUTE_REQUIRED`
- `UNSUPPORTED_FORMAT` · `UPLOAD_REJECTED` · `USER_ALREADY_EXISTS`
- `USER_ID_MISMATCH` · `USER_NOT_FOUND` · `USE_GROUP_ENDPOINT`
- `USE_LEAVE_ENDPOINT` · `USE_SOS_ENDPOINT` · `VALIDATION_FAILED`
- `VERSION_NOT_FOUND`
