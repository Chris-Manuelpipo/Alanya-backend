# Audit complet ALANYA — Montée en charge & base de données

**Date** : 6 août 2026
**Périmètre** : backend Node.js/Express (`Alanya-Backend`), base MySQL 8.0.26 de production (`alanyBD2027`), app Flutter (`Alanya`), avec inspection **en direct** du schéma réel de production (lecture seule).
**Contexte mesuré** : 89 utilisateurs, ~3 500 messages, base saine et petite — **c'est le moment idéal pour corriger avant la croissance.** Serveur MySQL : `max_connections=1000`, buffer pool 1 Go, `slow_query_log=OFF`, pic historique de 29 connexions.

> ⚠️ **Correction de prémisse** : la base est **MySQL 8 / InnoDB** (mysql2, port 17705), pas PostgreSQL. Le fichier `partition_alanyaBis.sql` est une note de réflexion non exécutable, incohérente avec le schéma réel (noms de tables inexistants, incompatibilités FK/partitionnement, rétention 31 jours destructrice) : **ne jamais l'appliquer en l'état** (voir §7).

---

## 1. Verdict global

L'architecture applicative a de très bonnes fondations : dénormalisation correcte de la liste des conversations (`lastMessage*`, `unreadCount`, `message_count`), idempotence des envois par `(senderID, clientId)`, client Flutter offline-first (Drift/SQLite, outbox, sync delta), file de jobs avec `FOR UPDATE SKIP LOCKED`, diffusion massive en modèle *pull* paresseux.

**Mais le système est aujourd'hui strictement mono-instance et mono-cœur**, et plusieurs mécanismes s'effondrent de façon corrélée dès quelques milliers d'utilisateurs actifs. Les 6 modes de panne principaux, par ordre de déclenchement probable :

1. **`io.emit('presence:updated')` global** — chaque bascule d'app de chaque utilisateur est diffusée à *toutes* les sockets. Coût quadratique. (`src/utils/blockUtils.js:170-176`)
2. **Envoi d'un broadcast → effondrement de `GET /conversations`** — `materializeForUser` ouvre une transaction + `FOR UPDATE` sur `users` pour chaque client qui ouvre l'app, sur un pool de 10 connexions à file illimitée. (`src/services/broadcastService.js:464-584`, `src/config/db.js:12-13`)
3. **Fan-out de notifications séquentiel** — ~6 requêtes SQL + 1 appel FCM *par destinataire*, en série. Groupe de 200 = ~1 200 requêtes + 40 s. (`src/services/notificationService.js:474-517`)
4. **Tempête de reconnexions client** — le watchdog Flutter neutralise le backoff exponentiel : reconnexion à T+2 s fixe, sans jitter, pour toute la flotte simultanément, chacune déclenchant une rafale de 6+ requêtes HTTP. (`Alanya/lib/api/socket_api.dart:128-142` + double pipeline de resync)
5. **Handler `typing` : 1+2N requêtes SQL par frappe** côté serveur, et `typing:start` émis à *chaque caractère* côté client. (`src/socket/handlers/chat/typing.js:4-21`, `Alanya/lib/screens/chats/chat/chat_actions.dart:1338-1352`)
6. **Médias sur disque local servis par Express** — interdit tout multi-instance (50 % de 404), et chaque avatar traverse l'event loop Node. (`src/middleware/upload.js:11-41`, `server.js:95`)

---

## 2. Base de données — structure réelle (inspectée en production)

### 2.1 Bombes à retardement de types (confirmées en direct)

| Constat | Table.colonne | Risque | Correctif |
|---|---|---|---|
| PK `INT` signée sur table à croissance rapide | `statut.ID` (et `statut_views.statutID`, `broadcast.statut_id`, `welcome_status_delivery.statut_id`) | Saturation à 2,1 Md (~14 mois à 5 M users avec statuts de bienvenue + diffusions) → service statuts mort | `BIGINT UNSIGNED` sur les 4 colonnes, via gh-ost/pt-osc |
| **Désaccord de type avec la cible** | `broadcast_delivery.conversID INT`, `broadcast_delivery.msgID INT`, `welcome_delivery.conversID INT` vs cibles `BIGINT` | Troncature/erreur 1264 silencieuse | `MODIFY ... BIGINT UNSIGNED` |
| Compteur plafonné | `conv_participants.unreadCount SMALLINT` (plafond 32 767) | Erreur 1264 sur `unreadCount + 1` dans un groupe actif non lu | `INT UNSIGNED` |
| Jeton tronqué | `users.fcm_token VARCHAR(255)` (les jetons FCM dépassent 255) | Push cassés silencieusement | Supprimer la colonne legacy au profit de `user_push_devices.fcmToken VARCHAR(2048)` |
| Texte statut | `statut.text TINYTEXT` = 255 octets (~63 emoji) | Troncature | `TEXT` |
| Précision seconde | `message.sendAt DATETIME` (vs `conversation.updatedAt DATETIME(3)`) | Pagination instable : deux messages dans la même seconde non ordonnables | `DATETIME(3)` + paginer par `msgID` |
| Aucune colonne `UNSIGNED` dans tout le schéma | — | 50 % de la plage d'ID gaspillée | Progressivement, avec les ALTER ci-dessus |

### 2.2 Poids des lignes `message` (mesuré : ~2,8 Ko/ligne en moyenne)

La table la plus chaude transporte des blobs dans la ligne :
- `mediaThumb MEDIUMTEXT` — vignette JPEG **base64**, mesurée à **36 Ko en moyenne** (276 vignettes en prod). Chargée par tous les `SELECT m.*` (liste, sync, socket), rediffusée à chaque destinataire.
- `ciphertext MEDIUMBLOB`, `archive_blob MEDIUMBLOB`, `replyToContent TEXT` (duplication du parent), `dr_header TEXT`.

Conséquence : pages InnoDB creuses, buffer pool pollué, chaque page de 50 messages = jusqu'à plusieurs Mo. **Correctif** : table satellite `message_thumb(msgID PK, thumb MEDIUMBLOB)` (binaire = −33 %), liste blanche de colonnes à la place de `SELECT m.*` partout (`src/socket/handlers/chat/messageSend.js:15-21`, `src/controllers/messageController.js:56-80, 1049-1071`).

### 2.3 Index manquants (les 4 plus rentables)

```sql
-- 1. Accusés de lecture/livraison : l'UPDATE actuel scanne + verrouille TOUT l'historique
--    de la conversation à chaque ouverture d'écran (readReceiptUtils.js:22, deliveryReceiptUtils.js:32)
ALTER TABLE message ADD INDEX idx_message_conv_status (conversationID, status, senderID);

-- 2. Sync delta getMessagesSince : curseurs (conversationID, msgID > ?) sans index adapté
ALTER TABLE message ADD INDEX idx_message_conv_msgid (conversationID, msgID);

-- 3. File de jobs : le polling (jusqu'à 20×/s) ne filtre pas sur `kind`,
--    donc idx_job_pret (kind, ...) est inutilisable → full scan + verrous chaque seconde
ALTER TABLE job_queue ADD INDEX idx_job_ready (failed_at, locked_at, run_after, id);

-- 4. Purge de jeton FCM mort : UPDATE users ... WHERE fcm_token = ? sans index = full scan
--    en rafale lors d'une rotation de jetons (notificationService.js:186)
ALTER TABLE users ADD INDEX idx_users_fcm_token (fcm_token(191));
```

Autres index utiles : `broadcast_delivery(delivered_at)` (purge 90 j), `user_export_jobs(expiresAt)`, `appareils(revoked_at)`, `user_push_devices(lastHeartbeatAt)`, `users(reset_otp_expires_at)`, et un index de ciblage broadcast `users(idPays, alanyaID)` / `(idVille, alanyaID)` — les critères de diffusion `idPays/idVille/genre/age` ne sont pas indexés pour la pagination keyset de `prepareBroadcast`.

Index redondants à supprimer (coût d'écriture gratuit) : `users.idx_users_phone` (doublon exact de `uq_phone` — confirmé en prod). Les index mono-colonne à faible cardinalité `idx_users_genre`, `idx_users_age`, `idx_users_exclus` sont d'un rendement douteux ; à réévaluer avec le slow log.

### 2.4 Requête chaude non indexable : résolution de conversation 1-1

`src/utils/directConversation.js:55-66` — à chaque ouverture de discussion : double self-join sur `conv_participants` + **sous-requête `COUNT(*)` sur `message` par candidate dans le `ORDER BY`**, alors que `conversation.message_count` (migration 041) existe précisément pour ça.
**Correctif 1 ligne** : `ORDER BY COALESCE(c.message_count,0) DESC, ...`
**Correctif structurel** : table `direct_conversation_key(userA, userB, conversID, PRIMARY KEY(userA,userB))` avec `userA=LEAST(a,b)` — rend les doublons de conversations 1-1 **impossibles** (aujourd'hui gérés par déduplication JS en aval, preuve qu'ils existent) et remplace la requête par un lookup PK.

### 2.5 Données jamais purgées (croissance illimitée)

Vérifié en production : **100 % des statuts sont expirés et toujours en base** (171/171), car le bail `welcome_status_purge` n'a jamais été semé dans `scheduler_leases` (confirmé : seuls 4 baux existent) → `tryAcquire` fait un `UPDATE` sur une ligne inexistante → `affectedRows=0` → **la purge n'a jamais tourné** (`server.js:222` vs `migrations/039:27-31`). Et les statuts *ordinaires* n'ont aucune purge du tout.

| Donnée | Purge actuelle | À mettre en place |
|---|---|---|
| `statut` expirés (+ `statut_views` par cascade) | ❌ jamais | `DELETE ... WHERE expiredAt < NOW() - INTERVAL 7 DAY LIMIT 5000` (job) |
| `message` | ❌ aucune rétention | Décision produit : archivage/partitionnement à terme (§7) |
| `callHistory` | ❌ | 12 mois |
| `userAccess` (1 ligne/login, à vie) | ❌ | 90 jours |
| `job_queue` échecs terminaux | ❌ (bloquent aussi leur `dedupe_key` → diffusion échouée non rejouable) | 30 jours + DLQ |
| `appareils` révoqués (table jointe à **chaque** requête authentifiée) | ❌ | 90 jours |
| OTP abandonnés (`users.reset_otp`, `email_change_otp`) | remis à NULL seulement en cas de succès | job de NULLification à expiration (sécurité) |
| `user_push_devices` sans heartbeat | seulement sur retour FCM `UNREGISTERED` | 180 jours |
| Fichiers `uploads/` jamais rattachés à un message | ❌ | job quotidien fichiers > 24 h non référencés |

### 2.6 Intégrité référentielle

- `broadcast_delivery` (`alanyaID`, `conversID`, `msgID`) et `welcome_delivery` (`alanyaID`, `conversID`) n'ont **aucune FK** hors `broadcast_id`/`config_id` ; `_purgeUser` ne les nettoie pas → orphelins à chaque suppression de compte.
- `broadcast` : zéro FK (`sender_id`, `created_by`, `statut_id`).
- FK `ON UPDATE CASCADE` sans `ON DELETE` (= RESTRICT) sur `message.senderID`, `callHistory.*`, `meeting.idOrganiser` : la suppression de compte ne peut pas aboutir structurellement — à trancher (anonymisation vs cascade).
- Pas de contrainte « un seul propriétaire par groupe » ni « une seule `welcome_config` active » (colonne générée + UNIQUE possible).

### 2.7 Gouvernance du schéma

**Il n'y a pas de runner de migrations** : application à la main, pas de table de suivi, numéros dupliqués (2× `015`, 2× `038`), `007` manquant, et **des divergences réelles constatées entre migrations et production** (ex. `idx_call_session` de la migration 036 absent de la table live). Mettre en place `dbmate` ou `umzug`+mysql2 avec backfill de l'état constaté, et activer `slow_query_log` (`long_query_time=0.5`) — aujourd'hui OFF, vous pilotez à l'aveugle.

---

## 3. Backend — pool, requêtes, transactions

### 3.1 Pool MySQL (`src/config/db.js`) — le goulot n°1

`connectionLimit: 10`, `queueLimit: 0` (file **illimitée** = latence infinie au lieu d'échec rapide), aucun timeout, aucun `pool.on('error')`, aucune instrumentation. Config cible :

```js
connectionLimit: 25, queueLimit: 200, connectTimeout: 5000,
enableKeepAlive: true, maxIdle: 10, idleTimeout: 60000
// + par connexion : SET SESSION max_execution_time=5000 (équivalent statement_timeout)
// + pool.on('error', ...) ; + wrapper loggant toute requête > 200 ms
```

Prévoir à terme un pool/réplica séparé pour `/api/admin` (requêtes `LIKE '%...%'`, `GROUP BY DATE(...)` sur `message` — elles saturent le pool de production).

### 3.2 N+1 principaux

| Site | Coût | Correctif |
|---|---|---|
| `notificationService.js:474-517` fan-out | ~6 SQL + 1 FCM **par destinataire**, en série | 4 requêtes batch `IN (...)` + `SUM(unreadCount) GROUP BY alanyaID` + `sendEachForMulticast` (500/lot) — le modèle existe déjà dans `broadcastService.js:213-260` |
| `conversationController.js:40-84` `attachParticipants` | 2 SQL/participant, appelée sur 8 chemins | Router vers `attachParticipantsBatch` (existe déjà, ≤3 requêtes) |
| `conversationController.js:706-718` ajout de membres | N+1 **imbriqué** (~20 000 requêtes pour 50 ajouts dans un groupe de 200) | Charger une fois + batch |
| `preferredContactController.js:34-38` `GET /contacts` | 1 SQL/contact, sans LIMIT | `LEFT JOIN blocked` dans la requête principale + pagination |
| `typing.js:4-21` | 1+2N SQL par frappe (et les 2N sont **inutiles en groupe**) | Résoudre le blocage 1 fois/conversation via le cache, debounce serveur 3 s |

### 3.3 Chemins chauds à corriger

- **`GET /conversations`** : sortir `materializeForUser` du chemin de lecture (le rendre asynchrone ou le déplacer côté producteur) ; remplacer le `FOR UPDATE` sur `users` par un CAS optimiste ; paginer (`LIMIT 50` + curseur) — aujourd'hui **aucun LIMIT** et la déduplication 1-1 se fait en JS sur l'ensemble ; liste blanche de colonnes (le `SELECT c.*` charge `lastMessage TEXT` × N).
- **`POST /messages` (HTTP)** : le fan-out FCM est `await`é dans la réponse (`messageController.js:159`) — passer en `setImmediate`/job queue comme le fait déjà le chemin socket (`messageSend.js:301`).
- **Accusés de lecture** : `UPDATE message ... WHERE conversationID=? AND status<3` sans index sur `status` → scan + verrous next-key sur tout l'historique à chaque ouverture d'écran. Index §2.3 + borner par `msgID`.
- **`GET /conversations/:id/reactions`** : `JSON_LENGTH(reactions)>0` sans LIMIT = scan complet de la conversation à chaque ouverture d'écran. Colonne générée `has_reactions` indexée + curseur.
- **`getMessagesSince`** : clause de `OR` non bornée (1 par conversation du client) — plafonner à ~100 curseurs + index `(conversationID, msgID)`.
- **Réactions emoji** : transaction + `SELECT FOR UPDATE` pour poser un emoji → un seul `UPDATE ... JSON_SET` atomique.
- **Écritures multi-étapes sans transaction** (envoi socket : `INSERT message` → `UPDATE conversation` → `UPDATE conv_participants` ; accusés ; compteurs statut) : à transactionnaliser + retry sur `ER_LOCK_DEADLOCK` (aucun retry nulle part aujourd'hui). Noter : le chemin socket **n'incrémente pas `message_count`** alors que le chemin HTTP le fait → divergence permanente du compteur qui sert d'arbitre à la déduplication 1-1.
- **Isolation** : passer en `READ COMMITTED` (défaut REPEATABLE READ = gap locks sur les `UPDATE` de plages).

---

## 4. Temps réel (Socket.IO)

### 4.1 Corrections immédiates (mono-instance)

1. **Supprimer le broadcast global de présence** (`blockUtils.js:170-176`) : émettre uniquement vers `io.to(contactIds.map(id => 'user_'+id))`. C'est aussi une fuite de données (présence envoyée à des inconnus).
2. **Fan-out en 1 émission** : remplacer les 6 boucles `for (p) io.to('user_'+p).emit(...)` par la forme tableau `io.to([...rooms]).emit(...)` (encodage unique au lieu de N sérialisations — un groupe de 256 avec vignette 150 Ko = ~38 Mo d'encodage synchrone aujourd'hui). Sites : `messageSend.js:288`, `notifyMessageStatus.js:34`, `typing.js:15`, `messageController.js:143`, `systemMessage.js:138`, `statusSocketService.js:29`.
3. **Rate-limiting socket** : aucun aujourd'hui (`socket.use()` token bucket : typing 1/2 s, read 2/s, presence 1/5 s) + timeout d'authentification 10 s (une socket anonyme reste ouverte indéfiniment) + `pingTimeout: 10000` + `maxHttpBufferSize: 256 Ko`.
4. **Fuite mémoire `groupRooms`** (`calls.js:71`) : jamais nettoyé dans `handleDisconnect` → entrées immortelles à chaque crash d'app en appel de groupe, rooms « pleines » de fantômes. Ajouter le nettoyage symétrique de celui des meetings.
5. **Sécurité** : `leave_group_call` (`calls.js:1231`) et `end_group_call` (`calls.js:1259`) n'ont **pas de garde d'authentification** — toute socket anonyme peut terminer un appel de groupe. Idem `meeting:leave` (`meetings.js:225`).
6. Valider `mediaThumb` ≤ 32 Ko dans le handler d'envoi ; réduire les `console.log` synchrones du chemin chaud (logger async type pino).

### 4.2 Prérequis multi-instances (dans l'ordre)

L'app est explicitement mono-process (12 magasins d'état en mémoire : `callState`, `callSessions`, `pendingCalls`, `qrLoginSessions`, `qrContactTokens`, `groupRooms`, états meetings, registre de sockets…). Chemin de migration :
1. `@socket.io/redis-adapter` + sticky sessions (ou `transports: ['websocket']` forcé côté client).
2. **Réécrire les 4 helpers de `userSocketRegistry.js:44-112`** (`isUserOnline`, `hasForegroundSocket`, `disconnectAppareilSockets`, `getConnectedDeviceIds`) : ils lisent l'état **local** de l'adapter et resteraient faux même avec Redis (révocation d'appareil inopérante = faille, doublons de push, présence en flip-flop). Utiliser `fetchSockets()`/`disconnectSockets()` ou un état Redis explicite avec TTL.
3. Externaliser les états critiques vers Redis (appels → QR → rooms).
4. Présence en `SETEX` Redis auto-expirant plutôt que `users.is_online` (supprime aussi le `resetStalePresence` du boot, qui en multi-instance éteindrait la présence des autres instances).
5. Timers d'appel (`setTimeout` locaux) → sorted set Redis + worker sous bail.

---

## 5. Workers, jobs, diffusion

- **Worker de jobs : concurrence 1** — tout l'asynchrone de la plateforme est séquentiel ; un backfill lent bloque les pushes. Passer à N boucles concurrentes (SKIP LOCKED le permet nativement), séparer les files par `kind`.
- **`reclaimOrphans` sans heartbeat** : un job > 10 min est repris **en parallèle de sa propre exécution** (handlers non idempotents → doublons FCM). Heartbeat du verrou toutes les 60 s.
- **`BROADCAST_WORKER_ENABLED`** gouverne *toute* la file (welcome, diffusions planifiées incluses) et est **désactivé par défaut** dans `.env.example` → renommer `JOB_WORKER_ENABLED` + avertissement.
- **Baux** : semer `welcome_status_purge` et `account_lifecycle` dans `scheduler_leases` (confirmé absents en prod), rendre `tryAcquire` auto-créateur, envelopper `startAccountLifecycleSchedulers` (aucun bail → double purge en cluster) ; TTL 55 s à renouveler pendant l'exécution (les schedulers longs doublent leurs envois).
- **Maintenance nocturne ancrée sur le boot** (`setInterval` 24 h sans exécution immédiate) + `pm2 restart` à chaque push → **ne tourne jamais** en développement actif. Planifier par heure d'horloge avec état persisté.
- **Broadcast** : bon design global (pull paresseux, pas d'insertion massive). À corriger : exploiter la `BatchResponse` de `sendEachForMulticast` pour purger les jetons morts (aujourd'hui ignorée → jetons morts re-ciblés à chaque diffusion) ; borner `runNightlyDeliveryMaintenance` dans le temps (sous-requête corrélée sur tout l'historique) ; rendre `prepareBroadcast` réentrant ; paralléliser les tranches.
- **Uploads** : cible S3/R2 + CDN avec URL pré-signées. En attendant, servir `/uploads` par nginx (`expires 1y`) ou a minima `express.static(dir, { maxAge: '365d', immutable: true })` — les noms de fichiers sont déjà immuables. Valider les *magic bytes* (le filtre actuel se fie au MIME client et accepte APK/ZIP jusqu'à 50 Mo servis publiquement).

---

## 6. Client Flutter (charge induite sur le backend)

Architecture saine (Drift, outbox, curseurs delta, cache média LRU). Correctifs par rendement :

**~20 lignes, gain majeur (semaine 1)** :
1. `/admin/stats` (≈10 agrégations dont `COUNT(*)` sur `message`) appelé **au login de chaque utilisateur** sans garde (`main.dart:924-928`, 403 avalé silencieusement) → conditionner au type de compte.
2. Pagination sans flag de fin (`chat_detail_screen.dart:396-413`) : en haut d'un fil épuisé, requêtes vides en boucle par frame de scroll → `_reachedStart` quand `loadOlderMessages()==0`.
3. Throttle `typing:start` à 2,5 s (`chat_actions.dart:1338`) — aujourd'hui 1 event/caractère.
4. `syncMessages(delta: true)` à l'ouverture de chat (`chat_detail_screen.dart:519`) — aujourd'hui les 50 derniers messages complets sont retéléchargés à chaque ouverture.
5. Accusé de lecture : HTTP conditionnel (`receipt_service.dart:57-78` envoie socket **et** HTTP systématiquement = double écriture).
6. Supprimer les doubles `GET /calls` et `GET /meetings` par écran (`calls_screen.dart:90-105`, `meets_screen.dart:99-109`).

**Stabilité sous charge (semaine 2)** :
7. **Watchdog socket** (`socket_api.dart:128-142`) : détruit/recrée l'instance à T+2 s fixe → remet le backoff natif à zéro. Backoff exponentiel avec jitter obligatoire, ne pas détruire l'instance si socket.io est déjà en reconnexion.
8. Fusionner les deux pipelines `auth:verified` (`chat_repository.dart:245` + `chat_provider.dart:145`) — travail dupliqué à chaque reconnexion.
9. `_scheduleListCatchUp()` conditionné à l'absence locale de la conversation (`socket_message_handlers.dart:152`) — aujourd'hui `GET /conversations` (non paginé) est relancé toutes les 8 s en conversation active.
10. Câbler `wifiOnly`/`dataSaver` (interrupteurs **morts** aujourd'hui) + `maxBytes` sur les vidéos (une vidéo 50 Mo reçue en groupe est téléchargée en 4G en arrière-plan) + file de prefetch à concurrence bornée.

**Coût d'infrastructure (semaines 3-4)** :
11. Compression avant upload : images WebP 1600 px q75, vidéos 720p (`flutter_image_compress`, `video_compress`) — aujourd'hui **aucune** compression vidéo, images non redimensionnées. Premier poste de coût d'une messagerie (un média de groupe est téléchargé N fois).
12. Vignettes JPEG/WebP q60 96 px (~3 Ko) au lieu de PNG base64 120 px (~25 Ko) (`image_thumbnail_service.dart:16-53`).
13. Endpoint batch `POST /messages/status` (réconciliation outbox = 1 GET par message pending toutes les 75 s).
14. `memCacheWidth` sur les `CachedNetworkImage` de listes ; ETag/304 sur les endpoints de liste.

---

## 7. Partitionnement — position

`partition_alanyaBis.sql` : **à ne pas exécuter** (noms de tables inexistants, casse l'idempotence `uq_message_sender_client`, incompatible avec les 4 FK de `message`, supprime les messages > 31 jours, pruning inopérant car aucune requête ne filtre sur `sendAt`).

Le partitionnement de `message` n'est **pas prioritaire** à ce stade (3 500 lignes). Quand la table approchera ~50-100 M de lignes : partitions **mensuelles** `RANGE(TO_DAYS(sendAt))`, avec 4 prérequis — dépose des FK, déplacement de l'idempotence vers une table dédiée non partitionnée, injection de `sendAt` dans les requêtes de lecture, `DATETIME(3)`. Maintenance par la `job_queue` (observable), jamais par `EVENT` MySQL (échec silencieux). Candidates plus simples et plus urgentes : purges applicatives (§2.5), qui rendent le partitionnement de `statut`/`userAccess`/`callHistory` inutile.

---

## 8. Plan d'action consolidé

### P0 — cette semaine (faible risque, rendement maximal)
| # | Action | Où |
|---|---|---|
| 1 | 4 index : `idx_message_conv_status`, `idx_message_conv_msgid`, `idx_job_ready`, `idx_users_fcm_token` | §2.3 |
| 2 | Pool : `connectionLimit 25`, `queueLimit 200`, timeouts, `pool.on('error')` | `db.js` |
| 3 | Présence : suppression du `io.emit` global → contacts uniquement | `blockUtils.js:170` |
| 4 | Fan-out : forme tableau `io.to([...]).emit()` sur les 6 sites | §4.1 |
| 5 | `materializeForUser` hors du chemin de `GET /conversations` + CAS optimiste | `conversationController.js:147` |
| 6 | `notifyNewMessage` : batch SQL + `sendEachForMulticast` + hors cycle HTTP | `notificationService.js` |
| 7 | `ORDER BY c.message_count` au lieu du `COUNT(*)` corrélé | `directConversation.js:63` |
| 8 | Semer les baux `welcome_status_purge` + `account_lifecycle` ; `tryAcquire` auto-créateur | `schedulerLease.js` |
| 9 | Flutter semaine 1 : garde admin, `_reachedStart`, throttle typing, delta sync, read HTTP conditionnel, doubles GET | §6 |
| 10 | Gardes d'auth sur `end_group_call`/`leave_group_call`/`meeting:leave` + fuite `groupRooms` | §4.1 |
| 11 | Activer `slow_query_log` (`long_query_time=0.5`) | serveur MySQL |

### P1 — semaines 2-4
Types (`statut.ID`, `broadcast_delivery.msgID/conversID`, `unreadCount`) via gh-ost · jobs de purge §2.5 · pagination `GET /conversations` + `/contacts` + `/reactions` + `/status/:id/views` · extraction `mediaThumb` + liste blanche de colonnes · watchdog socket Flutter + fusion des pipelines de resync · compression médias client · rate-limiting socket + timeout d'auth · runner de migrations · nginx devant `/uploads` · transactions manquantes + retry deadlock + `READ COMMITTED` · worker de jobs concurrent + heartbeat de verrou · exploitation de la `BatchResponse` FCM.

### P2 — préparation du multi-instances (avant tout `instances > 1`)
S3/CDN pour les médias · Redis (adapter Socket.IO, présence TTL, états d'appels/QR, caches de prefs) · réécriture des 4 helpers `userSocketRegistry` · sticky sessions ou websocket-only · `direct_conversation_key` · reclustering `conv_participants(alanyaID, conversID)` · pool/réplica admin · agrégats journaliers pour l'analytique · arrêt gracieux + `/health` instrumenté.

---

## 9. Bugs fonctionnels découverts incidemment

1. **Purge des statuts jamais exécutée** (bail absent — confirmé en prod : 171/171 statuts expirés présents).
2. **Maintenance nocturne jamais exécutée** si redéploiement < 24 h (`setInterval` ancré sur le boot + `pm2 restart` à chaque push).
3. `BROADCAST_WORKER_ENABLED` non défini par défaut → toute la file de jobs inerte silencieusement.
4. Chemin socket n'incrémente pas `conversation.message_count` (le chemin HTTP le fait) → arbitre de déduplication 1-1 faussé.
5. Diffusion en échec terminal non rejouable (`dedupe_key` bloqué, `reviveFailed` non branché sur `broadcast_*`).
6. « Wi-Fi uniquement » / « Économiseur de données » : réglages affichés mais **jamais consultés** par le code de téléchargement.
7. `end_group_call` exécutable par une socket non authentifiée (sécurité).
8. `/admin/stats` appelé par tous les clients au login (403 silencieux — vérifier que le middleware rejette bien avant le contrôleur).
9. Migrations vs production divergentes (ex. `idx_call_session` absent de la table live).
