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

module.exports = {
  createTrip,
  getActiveTrips,
  getTrip,
};
