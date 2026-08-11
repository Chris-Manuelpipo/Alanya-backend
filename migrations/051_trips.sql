-- Trajets de confiance — partage de position en temps réel au cercle de
-- confiance (liste système `kind = 'trust'`, plafonnée à 5), avec échéance
-- d'arrivée et alerte en cas de silence.
--
-- La promesse du volet est l'ÉCHÉANCE, pas la trace : « si l'utilisateur ne
-- confirme pas son arrivée, son cercle est prévenu ». L'échéance vit dans
-- `job_queue` (039) et ne dépend ni du GPS, ni du réseau, ni de l'OS. La trace
-- GPS n'est qu'un confort, et se purge vite.
--
-- L'audience est FIGÉE au démarrage : `trip_watcher` est un instantané de la
-- liste Confiance, sur le modèle de `broadcast_delivery` (040). Si l'alerte
-- part, on doit pouvoir dire qui a été prévenu — une audience dynamique rendrait
-- cela indécidable.
--
-- ⚠ Les migrations sont appliquées À LA MAIN : il n'existe ni exécuteur, ni
-- table de suivi. Appliquer CE FICHIER AVANT de déployer le code qui nomme ces
-- tables. Les quatre tables sont neuves et purement additives — aucun ALTER sur
-- une table existante, donc aucun verrou sur le trafic en cours.
--
-- Retour arrière : voir le bloc commenté en fin de fichier.

-- ---------------------------------------------------------------------------
-- 1. Le trajet
-- ---------------------------------------------------------------------------
-- Choix de type : DECIMAL(9,6) pour les coordonnées — 6 décimales ≈ 11 cm, très
-- au-delà de ce qu'un GPS de téléphone produit. Exact, comparable, et se
-- sauvegarde en dump texte sans surprise. PAS de type POINT ni d'index SPATIAL :
-- on ne cherche jamais de proximité entre trajets, l'arrivée s'évalue par trajet
-- contre une destination unique, en mémoire.
--
-- `state` et `kind` sont des ENUM et non des entiers : à taille de stockage
-- identique (1 octet), l'ENUM sort avec SHOW CREATE TABLE et le serveur refuse
-- ce qui n'y figure pas. Cf. `message.type` (001), dont le COMMENT s'arrête à
-- « 5=location » alors que les types 6, 7 et 8 existent.
-- Les valeurs de `state` sont déclarées DANS L'ORDRE DU CYCLE DE VIE : un
-- ORDER BY trie par ordre de déclaration, jamais alphabétiquement.
-- Toute valeur ajoutée plus tard doit l'être EN FIN DE LISTE (pas de
-- reconstruction de table tant qu'on reste sous 255 valeurs).

CREATE TABLE IF NOT EXISTS trip (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  owner_id         INT          NOT NULL,
  client_id        VARCHAR(64)  NOT NULL,          -- création idempotente (cf. broadcast)
  kind             ENUM('taxi','meeting','sos')    NOT NULL DEFAULT 'meeting',
  state            ENUM('active','awaiting_confirm','alert','sos',
                        'closed_confirmed','closed_cancelled',
                        'closed_expired','closed_unwatched')
                                                   NOT NULL DEFAULT 'active',

  -- Destination : colonnes créées dès maintenant, mais NON UTILISÉES par le
  -- lot 1 (échéance horaire seule). Les poser ici évite une migration 052.
  dest_lat         DECIMAL(9,6) NULL,
  dest_lng         DECIMAL(9,6) NULL,
  dest_label       VARCHAR(160) NULL,              -- géocodé UNE fois, à la création
  dest_radius_m    SMALLINT     NOT NULL DEFAULT 150,

  -- Valeurs de CONTRAT : recopiées à la création depuis tripPolicy.js, elles ne
  -- bougent plus. Un réglage ultérieur ne modifie jamais un trajet déjà parti —
  -- sinon on changerait le contrat après signature.
  eta_at           DATETIME     NULL,
  grace_minutes    SMALLINT     NOT NULL DEFAULT 10,
  max_duration_h   SMALLINT     NOT NULL DEFAULT 12,
  extensions       SMALLINT     NOT NULL DEFAULT 0,

  note             VARCHAR(200) NULL,              -- « taxi jaune, plaque LT 4471 »
  owner_device     VARCHAR(128) NULL,              -- seul appareil autorisé à émettre

  -- Dernière position connue : écrasée à chaque point. C'est elle que porte
  -- l'alerte ; `trip_point` ne sert qu'à rejouer la trace.
  last_lat         DECIMAL(9,6) NULL,
  last_lng         DECIMAL(9,6) NULL,
  last_acc_m       SMALLINT     NULL,
  last_battery     TINYINT      NULL,
  last_at          DATETIME     NULL,              -- horloge CLIENT (capture)
  last_seen_at     DATETIME     NULL,              -- horloge SERVEUR (dernier contact)
  stale            TINYINT(1)   NOT NULL DEFAULT 0,

  started_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  prompted_at      DATETIME     NULL,              -- passage en awaiting_confirm
  alerted_at       DATETIME     NULL,
  closed_at        DATETIME     NULL,
  close_reason     VARCHAR(30)  NULL,
  points_purged_at DATETIME     NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_trip_client (owner_id, client_id),
  KEY idx_trip_owner (owner_id, started_at),
  KEY idx_trip_open  (state, eta_at),              -- reprise à froid, jobs
  KEY idx_trip_purge (closed_at, points_purged_at),
  CONSTRAINT fk_trip_owner FOREIGN KEY (owner_id)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- La règle « un seul trajet ouvert par utilisateur » n'est PAS exprimable en
-- contrainte : MySQL n'a pas d'index unique partiel. Elle est vérifiée dans le
-- contrôleur (409 TRIP_ALREADY_ACTIVE), comme la règle « un seul dossier de
-- certification ouvert ». `idx_trip_owner` sert cette vérification.

-- ---------------------------------------------------------------------------
-- 2. L'audience, figée au démarrage
-- ---------------------------------------------------------------------------
-- Instantané des membres de la liste `kind = 'trust'` du propriétaire, pris une
-- seule fois. Aucune sous-sélection : le cercle EST l'audience, en entier.
-- `msgID` / `conversID` mémorisent la carte de type 9 posée chez ce membre, pour
-- pouvoir la muter ensuite sans la rechercher.

CREATE TABLE IF NOT EXISTS trip_watcher (
  trip_id       BIGINT      NOT NULL,
  alanyaID      INT         NOT NULL,
  state         ENUM('active','revoked','left') NOT NULL DEFAULT 'active',
  revoke_reason VARCHAR(20) NULL,                  -- blocked | removed | left
  msgID         INT         NULL,
  conversID     INT         NULL,
  added_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at   DATETIME    NULL,
  seen_at       DATETIME    NULL,                  -- « j'ai vu », remonté au propriétaire
  revoked_at    DATETIME    NULL,
  PRIMARY KEY (trip_id, alanyaID),
  KEY idx_tw_user (alanyaID, trip_id),             -- « les trajets que je suis »
  CONSTRAINT fk_tw_trip FOREIGN KEY (trip_id)
    REFERENCES trip(id) ON DELETE CASCADE,
  CONSTRAINT fk_tw_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. La trace, décimée
-- ---------------------------------------------------------------------------
-- Une ligne toutes les 30 s AU PLUS (TRIP_PERSIST_MIN_S), et seulement si la
-- position a réellement bougé : un trajet à l'arrêt n'écrit rien.
--
-- Les deux horodatages ne font pas double emploi. `recorded_at` est l'heure de
-- CAPTURE (horloge client, milliseconde) ; `received_at` celle de RÉCEPTION
-- (horloge serveur). Un écart qui se creuse entre les deux = appareil vivant
-- dont le GPS ne dit plus rien. C'est ce qui distingue « immobile » de
-- « traceur mort ».
--
-- RÉTENTION : purgée 24 h après la clôture (30 jours si le trajet s'est clos
-- sur une alerte). Un registre permanent des déplacements de tous les
-- utilisateurs n'est justifié par aucun besoin produit.

CREATE TABLE IF NOT EXISTS trip_point (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  trip_id     BIGINT       NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  acc_m       SMALLINT     NULL,                   -- > 100 : ignoré pour la détection
  speed_kmh   SMALLINT     NULL,
  battery     TINYINT      NULL,
  recorded_at DATETIME(3)  NOT NULL,
  received_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_point_trip (trip_id, recorded_at),
  CONSTRAINT fk_point_trip FOREIGN KEY (trip_id)
    REFERENCES trip(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Le journal
-- ---------------------------------------------------------------------------
-- Source de la frise affichée au récapitulatif, ET seule mémoire de ce qui a été
-- notifié à qui. `kind` est un VARCHAR et non un ENUM : contrairement à
-- `trip.state`, cet ensemble est OUVERT et gagnera des valeurs au fil des
-- versions, comme `job_queue.kind` avant lui.
--
-- Valeurs du lot 1 : started, extended, eta_due, confirmed, alerted, resolved,
-- watcher_seen, watcher_revoked, signal_lost, signal_back, low_battery,
-- device_takeover, closed.
-- Lot 2 : arrival_detected, sos.

CREATE TABLE IF NOT EXISTS trip_event (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  trip_id    BIGINT      NOT NULL,
  kind       VARCHAR(24) NOT NULL,
  actor_id   INT         NULL,                     -- NULL = système (job, serveur)
  meta       JSON        NULL,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_trip (trip_id, id),
  CONSTRAINT fk_event_trip FOREIGN KEY (trip_id)
    REFERENCES trip(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Le bail de purge nocturne
-- ---------------------------------------------------------------------------
-- 039 n'en sème que 4, et 048 documente le bug de production qu'a causé un bail
-- jamais semé (la purge des statuts de bienvenue n'a jamais tourné). On sème
-- donc explicitement, même si schedulerLease.tryAcquire est depuis
-- auto-créateur.

INSERT IGNORE INTO scheduler_leases (name) VALUES ('trip_nightly_purge');

-- ---------------------------------------------------------------------------
-- Vérification après application
-- ---------------------------------------------------------------------------
--   SHOW CREATE TABLE trip\G
--   SELECT COUNT(*) FROM information_schema.tables
--    WHERE table_schema = DATABASE()
--      AND table_name IN ('trip','trip_watcher','trip_point','trip_event');
--   -- doit renvoyer 4
--   SELECT name FROM scheduler_leases WHERE name = 'trip_nightly_purge';
--   -- doit renvoyer 1 ligne
--
-- ---------------------------------------------------------------------------
-- Retour arrière
-- ---------------------------------------------------------------------------
-- Sans risque tant que le code n'est pas déployé : aucune table existante n'est
-- touchée. Supprimer dans cet ordre (les FK l'imposent) :
--
--   DROP TABLE IF EXISTS trip_event;
--   DROP TABLE IF EXISTS trip_point;
--   DROP TABLE IF EXISTS trip_watcher;
--   DROP TABLE IF EXISTS trip;
--   DELETE FROM scheduler_leases WHERE name = 'trip_nightly_purge';
