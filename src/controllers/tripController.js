/**
 * Trajets de confiance — création et lecture (lot 1).
 *
 * Style repris de `contactListController` : cadrage systématique sur
 * `req.user.alanyaID` (jamais un identifiant fourni par le client),
 * `pool.execute`, codes 400/403/404/409.
 *
 * Rappel du postulat du volet : la garantie de sûreté est l'ÉCHÉANCE, pas la
 * trace. C'est pourquoi `eta_at` est calculé et gardé par le serveur — le client
 * n'envoie qu'une heure ou une durée, et son horloge ne fait jamais foi.
 */

const pool = require('../config/db');
const policy = require('../constants/tripPolicy');
const {
  NOTE_MAX,
  CLIENT_ID_MAX,
  DEVICE_ID_MAX,
  clean,
  parseTripId,
  parseKind,
  resolveEta,
  toSqlDate,
} = require('../utils/tripInput');
const {
  loadTrustCircle,
  tripRow,
  findTripById,
  findOpenTripByOwner,
  findTripByClientId,
  findOpenTripsAsWatcher,
  loadWatchers,
  isActiveWatcher,
  loadEvents,
  logEvent,
  postTripCard,
} = require('../services/tripService');
const { arm, transition, dedupe } = require('../services/tripWorkers');
const { enqueue, isJobWorkerEnabled } = require('../services/jobQueue');

// ---------------------------------------------------------------------------
// POST /api/trips
// ---------------------------------------------------------------------------

const createTrip = async (req, res) => {
  const alanyaID = req.user.alanyaID;
  const io = req.app.get('io');

  const clientId = clean(req.body?.clientId, CLIENT_ID_MAX);
  if (!clientId) {
    return res.status(400).json({ error: 'clientId requis', code: 'CLIENT_ID_REQUIRED' });
  }

  const kind = parseKind(req.body?.kind);
  if (kind === 'sos') {
    // Le SOS est un autre parcours : il crée un trajet déjà en alerte, sans
    // échéance. Hors périmètre du lot 1.
    return res.status(501).json({ error: 'SOS non disponible', code: 'SOS_NOT_AVAILABLE' });
  }

  const note = clean(req.body?.note, NOTE_MAX);

  // Refus explicite plutôt que promesse silencieuse. Sans le worker, aucune
  // échéance ne se déclenche : le trajet resterait « actif » indéfiniment et
  // personne ne serait jamais prévenu. Mieux vaut ne pas partir que partir sans
  // filet en croyant en avoir un.
  if (!isJobWorkerEnabled()) {
    console.error('[Trip] refus de création : le worker de jobs ne tourne pas');
    return res.status(503).json({
      error: 'Service temporairement indisponible',
      code: 'JOB_WORKER_DOWN',
    });
  }

  try {
    // Idempotence : un réseau qui bafouille ne doit pas créer deux trajets.
    const existing = await findTripByClientId(alanyaID, clientId);
    if (existing) {
      const watchers = await loadWatchers(existing.id);
      return res.status(200).json({
        trip: tripRow(existing, { watchers, isOwner: true }),
        policy: policy.publicPolicy(),
      });
    }

    const open = await findOpenTripByOwner(alanyaID);
    if (open) {
      return res.status(409).json({
        error: 'Un trajet est déjà en cours',
        code: 'TRIP_ALREADY_ACTIVE',
        tripId: Number(open.id),
      });
    }

    const eta = resolveEta(req.body ?? {}, policy.CONTRACT.maxDurationH);
    if (eta.error) {
      return res.status(400).json({ error: eta.error, code: 'INVALID_ETA' });
    }

    // L'audience n'est PAS un paramètre de la requête : le serveur lit la liste
    // Confiance du porteur du jeton. Le cercle est l'audience, en entier.
    const circle = await loadTrustCircle(alanyaID);
    if (circle.length === 0) {
      return res.status(409).json({
        error: 'Votre cercle de confiance est vide',
        code: 'TRUST_LIST_EMPTY',
      });
    }

    const conn = await pool.getConnection();
    let tripId;
    try {
      await conn.beginTransaction();

      const [ins] = await conn.execute(
        `INSERT INTO trip
           (owner_id, client_id, kind, state, eta_at,
            grace_minutes, max_duration_h, dest_radius_m, note, owner_device)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        [
          alanyaID, clientId, kind, toSqlDate(eta.etaAt),
          policy.CONTRACT.graceMinutes,
          policy.CONTRACT.maxDurationH,
          policy.CONTRACT.destRadiusM,
          note,
          clean(req.body?.deviceId, DEVICE_ID_MAX),
        ],
      );
      tripId = ins.insertId;

      const trip = await findTripById(tripId, conn);

      // Instantané de l'audience, puis la carte chez chacun.
      for (const member of circle) {
        const { msgID, conversID } = await postTripCard(conn, trip, Number(member.alanyaID));
        await conn.execute(
          `INSERT INTO trip_watcher (trip_id, alanyaID, msgID, conversID, notified_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [tripId, Number(member.alanyaID), msgID, conversID],
        );
      }

      await logEvent(tripId, 'started', {
        actorId: alanyaID,
        meta: { kind, watchers: circle.length },
      }, conn);

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const trip = await findTripById(tripId);
    const watchers = await loadWatchers(tripId);
    const body = tripRow(trip, { watchers, isOwner: true });

    // Armement APRÈS le commit : un job déclenché pendant la transaction ne
    // verrait pas encore le trajet. C'est ici que naît la garantie du volet —
    // sans cet appel, un trajet ne s'achèverait jamais tout seul.
    await arm(trip);

    // Hors du chemin critique : la réponse ne doit pas attendre le fan-out.
    setImmediate(() => {
      try {
        if (io) {
          io.to(watchers.map((w) => `user_${w.alanyaID}`)).emit('trip:started', {
            trip: tripRow(trip, { isOwner: false }),
          });
        }
      } catch (err) {
        console.error('[Trip] fan-out trip:started échoué:', err.message);
      }
    });

    return res.status(201).json({ trip: body, policy: policy.publicPolicy() });
  } catch (error) {
    console.error('[Trip] createTrip:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/trips/active
// ---------------------------------------------------------------------------

/** Reprise à froid : mon trajet ouvert, et ceux que je suis. C'est le premier
 *  appel de l'application au démarrage. */
const getActiveTrips = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    const mine = await findOpenTripByOwner(alanyaID);
    const mineBody = mine
      ? tripRow(mine, { watchers: await loadWatchers(mine.id), isOwner: true })
      : null;

    const watched = await findOpenTripsAsWatcher(alanyaID);
    const watchedBody = watched.map((t) => tripRow(t, { isOwner: false }));

    return res.json({
      mine: mineBody,
      watching: watchedBody,
      policy: policy.publicPolicy(),
    });
  } catch (error) {
    console.error('[Trip] getActiveTrips:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/trips/:tripId
// ---------------------------------------------------------------------------

const getTrip = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const tripId = parseTripId(req.params.tripId);
    if (!tripId) return res.status(400).json({ error: 'tripId invalide' });

    const trip = await findTripById(tripId);
    // 404 indifférencié : on ne révèle pas l'existence du trajet d'un autre.
    if (!trip) return res.status(404).json({ error: 'Trajet introuvable' });

    const isOwner = Number(trip.owner_id) === Number(alanyaID);
    if (!isOwner && !(await isActiveWatcher(tripId, alanyaID))) {
      return res.status(404).json({ error: 'Trajet introuvable' });
    }

    // Le propriétaire voit qui suit ; un destinataire ne voit que le nombre —
    // cela rassure sans exposer le carnet d'adresses de quelqu'un d'autre.
    const watchers = await loadWatchers(tripId);
    const body = isOwner
      ? tripRow(trip, { watchers, isOwner: true })
      : { ...tripRow(trip, { isOwner: false }), watcherCount: watchers.length };

    return res.json({
      trip: body,
      events: await loadEvents(tripId),
      policy: policy.publicPolicy(),
    });
  } catch (error) {
    console.error('[Trip] getTrip:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};


// ---------------------------------------------------------------------------
// Actions du propriétaire
// ---------------------------------------------------------------------------

/** Charge un trajet ouvert dont je suis propriétaire, ou renvoie l'erreur HTTP
 *  qui convient. Facteur commun de toutes les actions ci-dessous. */
const monTrajetOuvert = async (req, res) => {
  const tripId = parseTripId(req.params.tripId);
  if (!tripId) {
    res.status(400).json({ error: 'tripId invalide' });
    return null;
  }
  const trip = await findTripById(tripId);
  if (!trip || Number(trip.owner_id) !== Number(req.user.alanyaID)) {
    res.status(404).json({ error: 'Trajet introuvable' });
    return null;
  }
  if (!policy.OPEN_STATES.has(trip.state)) {
    res.status(409).json({ error: 'Trajet déjà clos', code: 'TRIP_TERMINAL' });
    return null;
  }
  return trip;
};

/** Confirmer son arrivée. Possible même APRÈS une alerte — mais celle-ci reste
 *  au journal : une alerte émise se résout, elle ne s'efface pas. */
const confirmTrip = async (req, res) => {
  try {
    const trip = await monTrajetOuvert(req, res);
    if (!trip) return;
    const apresAlerte = policy.ALERT_STATES.has(trip.state);
    await transition(trip.id, 'closed_confirmed', {
      reason: apresAlerte ? 'confirmed_after_alert' : 'confirmed',
      actorId: req.user.alanyaID,
    });
    return res.json({ trip: tripRow(await findTripById(trip.id), { isOwner: true }) });
  } catch (error) {
    console.error('[Trip] confirmTrip:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Prolonger. Illimité — un embouteillage ne doit pas coûter une alerte.
 * Chaque prolongation écrit un événement visible du cercle : cela rassure sans
 * alerter, et c'est ce qui rend le geste préférable au silence.
 */
const extendTrip = async (req, res) => {
  try {
    const trip = await monTrajetOuvert(req, res);
    if (!trip) return;

    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
      return res.status(400).json({ error: 'minutes invalide', code: 'INVALID_EXTENSION' });
    }

    // On repart de l'échéance actuelle, pas de maintenant : prolonger de 15 min
    // à T+3 doit donner T+15, pas T+18.
    const base = trip.eta_at ? new Date(trip.eta_at) : new Date();
    const nouvelle = new Date(base.getTime() + minutes * 60_000);
    const plafond = new Date(
      new Date(trip.started_at).getTime() + Number(trip.max_duration_h) * 3600_000,
    );
    if (nouvelle > plafond) {
      return res.status(409).json({
        error: 'La durée maximale serait dépassée',
        code: 'MAX_DURATION_REACHED',
      });
    }

    await pool.execute(
      `UPDATE trip
          SET eta_at = ?, extensions = extensions + 1,
              state = 'active', prompted_at = NULL
        WHERE id = ?`,
      [toSqlDate(nouvelle), trip.id],
    );
    const majeur = await findTripById(trip.id);
    await logEvent(trip.id, 'extended', {
      actorId: req.user.alanyaID,
      meta: { minutes, etaAt: nouvelle.toISOString() },
    });

    // Ré-armement complet. `arm` commence par désarmer : sans ce DELETE,
    // l'ancienne échéance survivrait et l'alerte partirait à l'heure initiale.
    await arm(majeur);
    await transition(trip.id, 'active', { actorId: req.user.alanyaID });

    return res.json({ trip: tripRow(await findTripById(trip.id), { isOwner: true }) });
  } catch (error) {
    console.error('[Trip] extendTrip:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Arrêter le partage. Toujours autorisé, sans confirmation.
 *
 * Le message envoyé au cercle est délibérément NEUTRE. Si arrêter paraissait
 * suspect, arrêter deviendrait punissable par quelqu'un qui regarde
 * par-dessus l'épaule — et la fonctionnalité se retournerait contre la personne
 * qu'elle protège.
 */
const cancelTrip = async (req, res) => {
  try {
    const trip = await monTrajetOuvert(req, res);
    if (!trip) return;
    await transition(trip.id, 'closed_cancelled', {
      reason: 'stopped_by_owner',
      actorId: req.user.alanyaID,
    });
    return res.json({ trip: tripRow(await findTripById(trip.id), { isOwner: true }) });
  } catch (error) {
    console.error('[Trip] cancelTrip:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/** Révoquer un destinataire. Si c'était le dernier, un job clôt le trajet cinq
 *  minutes plus tard : un trajet sans témoin n'est plus de la sécurité. */
const revokeWatcher = async (req, res) => {
  try {
    const trip = await monTrajetOuvert(req, res);
    if (!trip) return;
    const cible = parseTripId(req.params.alanyaID);
    if (!cible) return res.status(400).json({ error: 'alanyaID invalide' });

    const [r] = await pool.execute(
      `UPDATE trip_watcher
          SET state = 'revoked', revoke_reason = 'removed', revoked_at = NOW()
        WHERE trip_id = ? AND alanyaID = ? AND state = 'active'`,
      [trip.id, cible],
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ error: 'Destinataire introuvable' });
    }
    await logEvent(trip.id, 'watcher_revoked', { actorId: req.user.alanyaID });

    const restants = await loadWatchers(trip.id);
    if (restants.length === 0) {
      await enqueue('trip_no_watcher', { tripId: Number(trip.id) }, {
        dedupeKey: dedupe(trip.id),
        runAfter: new Date(Date.now() + policy.CONTRACT.noWatcherGraceMin * 60_000),
      });
    }
    return res.json({ watchers: restants });
  } catch (error) {
    console.error('[Trip] revokeWatcher:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ---------------------------------------------------------------------------
// Historique et trace
// ---------------------------------------------------------------------------

/** Mes trajets passés. Réservé au propriétaire : un destinataire n'a PAS
 *  d'historique — c'est ce qui empêche « où étais-tu mardi » d'exister. */
const getHistory = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const limite = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const curseur = parseInt(req.query.cursor, 10);

    const [rows] = await pool.execute(
      `SELECT t.id, t.owner_id, t.kind, t.state, t.eta_at, t.grace_minutes,
              t.max_duration_h, t.extensions, t.note, t.dest_label,
              t.dest_lat, t.dest_lng, t.dest_radius_m,
              t.last_lat, t.last_lng, t.last_acc_m, t.last_battery, t.last_at,
              t.stale, t.started_at, t.prompted_at, t.alerted_at,
              t.closed_at, t.close_reason, t.owner_device, t.last_seen_at,
              (SELECT COUNT(*) FROM trip_watcher w WHERE w.trip_id = t.id) AS wc
         FROM trip t
        WHERE t.owner_id = ? ${Number.isFinite(curseur) ? 'AND t.id < ?' : ''}
        ORDER BY t.id DESC
        LIMIT ${limite}`,
      Number.isFinite(curseur) ? [alanyaID, curseur] : [alanyaID],
    );

    return res.json({
      trips: rows.map((r) => ({
        ...tripRow(r, { isOwner: true }),
        watcherCount: Number(r.wc) || 0,
      })),
      nextCursor: rows.length === limite ? Number(rows[rows.length - 1].id) : null,
    });
  } catch (error) {
    console.error('[Trip] getHistory:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/** La trace, pour rejouer un trajet. Vide après la purge — c'est normal, et
 *  l'écran doit le dire plutôt que d'afficher une carte muette. */
const getPoints = async (req, res) => {
  try {
    const tripId = parseTripId(req.params.tripId);
    if (!tripId) return res.status(400).json({ error: 'tripId invalide' });

    const trip = await findTripById(tripId);
    if (!trip) return res.status(404).json({ error: 'Trajet introuvable' });
    const isOwner = Number(trip.owner_id) === Number(req.user.alanyaID);
    if (!isOwner && !(await isActiveWatcher(tripId, req.user.alanyaID))) {
      return res.status(404).json({ error: 'Trajet introuvable' });
    }

    const [rows] = await pool.execute(
      `SELECT lat, lng, acc_m, battery, recorded_at
         FROM trip_point WHERE trip_id = ?
        ORDER BY recorded_at ASC LIMIT 2000`,
      [tripId],
    );
    return res.json({
      points: rows.map((r) => ({
        lat: Number(r.lat),
        lng: Number(r.lng),
        accuracyM: r.acc_m == null ? null : Number(r.acc_m),
        batteryPct: r.battery == null ? null : Number(r.battery),
        recordedAt: r.recorded_at,
      })),
      purged: trip.points_purged_at != null,
    });
  } catch (error) {
    console.error('[Trip] getPoints:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Supprimer un trajet de son historique.
 *
 * ⚠ Un trajet clos sur une ALERTE est verrouillé pendant 30 jours. Ce n'est pas
 * une contrainte technique : c'est une mesure anti-coercition. Personne ne doit
 * pouvoir contraindre un proche à effacer la trace d'un incident dans la
 * minute qui suit.
 */
const deleteTrip = async (req, res) => {
  try {
    const tripId = parseTripId(req.params.tripId);
    if (!tripId) return res.status(400).json({ error: 'tripId invalide' });

    const trip = await findTripById(tripId);
    if (!trip || Number(trip.owner_id) !== Number(req.user.alanyaID)) {
      return res.status(404).json({ error: 'Trajet introuvable' });
    }
    if (policy.OPEN_STATES.has(trip.state)) {
      return res.status(409).json({
        error: 'Arrêtez le trajet avant de le supprimer',
        code: 'TRIP_STILL_OPEN',
      });
    }

    if (trip.alerted_at) {
      const verrouJusque = new Date(new Date(trip.alerted_at).getTime()
        + policy.RETENTION.incidentDeleteLockDays * 86_400_000);
      if (verrouJusque > new Date()) {
        return res.status(423).json({
          error: 'Ce trajet est conservé après une alerte',
          code: 'TRIP_INCIDENT_LOCKED',
          lockedUntil: verrouJusque.toISOString(),
        });
      }
    }

    // Le CASCADE emporte points, destinataires et événements.
    await pool.execute('DELETE FROM trip WHERE id = ?', [tripId]);
    return res.json({ deleted: true });
  } catch (error) {
    console.error('[Trip] deleteTrip:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  createTrip,
  getActiveTrips,
  getTrip,
  confirmTrip,
  extendTrip,
  cancelTrip,
  revokeWatcher,
  getHistory,
  getPoints,
  deleteTrip,
};
