/**
 * Trajets de confiance — flux temps réel des positions.
 *
 * Deux règles gouvernent ce fichier, et il vaut mieux les avoir en tête avant
 * d'y toucher :
 *
 *   1. **La room ne porte que le mouvement.** `trip_<id>` sert au flux haute
 *      fréquence, et à rien d'autre. Tout ce qui doit ATTEINDRE un destinataire
 *      — changement d'état, alerte, clôture — passe par `emitToUser` plus la
 *      notification poussée. Un proche dont aucun appareil n'est abonné à la
 *      room doit quand même être prévenu. Une alerte ne transite JAMAIS par la
 *      seule room.
 *
 *   2. **Un seul appareil émet.** `trip.owner_device` désigne le porteur.
 *      Sans ce verrou, deux téléphones du même compte entrelacent leurs
 *      positions et la trace zigzague entre deux endroits. Motif repris de
 *      `callDeviceOwnership`.
 */

const pool = require('../../config/db');
const tripState = require('../state/tripState');
const policy = require('../../constants/tripPolicy');
const {
  findTripById,
  isActiveWatcher,
  logEvent,
} = require('../../services/tripService');

const MAX_BATCH = 200;

const room = (tripId) => `trip_${Number(tripId)}`;

/** Une coordonnée hors bornes est un bug client, pas une position. */
const validPoint = (p) => {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const recordedAt = new Date(p.recordedAt ?? Date.now());
  if (Number.isNaN(recordedAt.getTime())) return null;
  // Un horodatage futur trahit une horloge fausse : on le ramène à maintenant
  // plutôt que de le rejeter — la position, elle, reste utile.
  const now = Date.now();
  const ts = recordedAt.getTime() > now + 60_000 ? new Date(now) : recordedAt;
  return {
    lat, lng,
    accuracyM: Number.isFinite(Number(p.accuracyM)) ? Number(p.accuracyM) : null,
    speedKmh: Number.isFinite(Number(p.speedKmh)) ? Number(p.speedKmh) : null,
    battery: Number.isFinite(Number(p.battery)) ? Number(p.battery) : null,
    recordedAt: ts,
    clientSeq: Number.isFinite(Number(p.clientSeq)) ? Number(p.clientSeq) : null,
  };
};

const toSql = (d) => d.toISOString().slice(0, 23).replace('T', ' ');

/** Autorisation d'accès à un trajet : propriétaire, ou destinataire actif. */
const canSee = async (trip, alanyaID) => {
  if (!trip) return false;
  if (Number(trip.owner_id) === Number(alanyaID)) return true;
  return isActiveWatcher(trip.id, alanyaID);
};

// ---------------------------------------------------------------------------
// trip:subscribe / trip:unsubscribe
// ---------------------------------------------------------------------------

const tripSubscribe = (io, socket) => {
  socket.on('trip:subscribe', async (data) => {
    try {
      if (!socket.authenticated) return;
      const tripId = Number(data?.tripId);
      if (!tripId) return;

      const trip = await findTripById(tripId);
      if (!(await canSee(trip, socket.alanyaID))) {
        return socket.emit('trip:error', { tripId, code: 'FORBIDDEN' });
      }
      // Un trajet clos n'a plus de flux : inutile de garder une room ouverte.
      if (!policy.OPEN_STATES.has(trip.state)) {
        return socket.emit('trip:state', { tripId, state: trip.state, closed: true });
      }

      socket.join(room(tripId));
      socket.emit('trip:state', {
        tripId,
        state: trip.state,
        stale: tripState.isStale(tripId),
        policy: policy.publicPolicy(),
      });
    } catch (e) {
      console.error('[Socket trip:subscribe]', e.message);
    }
  });
};

const tripUnsubscribe = (io, socket) => {
  socket.on('trip:unsubscribe', (data) => {
    const tripId = Number(data?.tripId);
    if (tripId) socket.leave(room(tripId));
  });
};

// ---------------------------------------------------------------------------
// trip:position
// ---------------------------------------------------------------------------

/**
 * Ingère une position et décide de la suite. Rien n'est renvoyé au client :
 * l'émission est unidirectionnelle et sans accusé. Une position perdue est
 * remplacée par la suivante — c'est la règle « un tic peut se perdre, une
 * transition d'état non ».
 */
const ingest = async (io, socket, trip, raw) => {
  const p = validPoint(raw);
  if (!p) return;
  if (p.clientSeq != null && tripState.isDuplicate(trip.id, p.clientSeq)) return;
  tripState.rememberSeq(trip.id, p.clientSeq);

  const { broadcast, persist } = tripState.admit(trip.id, p);

  // La dernière position vit dans `trip` et s'écrase ; `trip_point` ne sert
  // qu'à rejouer la trace.
  await pool.execute(
    `UPDATE trip
        SET last_lat = ?, last_lng = ?, last_acc_m = ?, last_battery = ?,
            last_at = ?, last_seen_at = NOW(), stale = 0
      WHERE id = ?`,
    [p.lat, p.lng, p.accuracyM, p.battery, toSql(p.recordedAt), trip.id],
  );

  if (persist) {
    await pool.execute(
      `INSERT INTO trip_point
         (trip_id, lat, lng, acc_m, speed_kmh, battery, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [trip.id, p.lat, p.lng, p.accuracyM, p.speedKmh, p.battery,
       toSql(p.recordedAt)],
    );
  }

  if (broadcast) {
    io.to(room(trip.id)).emit('trip:position', {
      tripId: Number(trip.id),
      lat: p.lat,
      lng: p.lng,
      accuracyM: p.accuracyM,
      batteryPct: p.battery,
      recordedAt: p.recordedAt.toISOString(),
    });
  }

  // Ré-arme la péremption à chaque contact. Le régime — donc le délai — suit
  // la proximité de l'échéance.
  const msToEta = trip.eta_at ? new Date(trip.eta_at).getTime() - Date.now() : null;
  tripState.setRegime(trip.id,
    policy.regimeFor({ state: trip.state, msToEta, batteryPct: p.battery }).name);
  tripState.armStale(trip.id, onStale(io));
};

/** Passage en péremption : on informe, on n'alerte pas. La chaîne d'échéance
 *  continue de tourner de son côté, indépendamment du GPS. */
const onStale = (io) => async (tripId, lastPoint) => {
  try {
    await pool.execute('UPDATE trip SET stale = 1 WHERE id = ?', [tripId]);
    await logEvent(tripId, 'signal_lost', {
      meta: lastPoint ? { lat: lastPoint.lat, lng: lastPoint.lng } : null,
    });
    io.to(room(tripId)).emit('trip:stale', { tripId, stale: true });
  } catch (e) {
    console.error('[Trip] onStale:', e.message);
  }
};

const tripPosition = (io, socket) => {
  socket.on('trip:position', async (data) => {
    try {
      if (!socket.authenticated) return;
      const tripId = Number(data?.tripId);
      if (!tripId) return;

      const trip = await findTripById(tripId);
      if (!trip) return;
      // Seul le propriétaire émet — et seulement depuis l'appareil porteur.
      if (Number(trip.owner_id) !== Number(socket.alanyaID)) {
        return socket.emit('trip:error', { tripId, code: 'FORBIDDEN' });
      }
      if (!policy.OPEN_STATES.has(trip.state)) return;
      if (trip.owner_device && socket.deviceId &&
          String(trip.owner_device) !== String(socket.deviceId)) {
        return socket.emit('trip:error', { tripId, code: 'DEVICE_NOT_OWNER' });
      }

      await ingest(io, socket, trip, data);
    } catch (e) {
      console.error('[Socket trip:position]', e.message);
    }
  });
};

/** Vidange du tampon hors ligne. Les points repartent avec LEUR horodatage de
 *  capture ; la déduplication rend l'opération rejouable sans doublon. */
const tripPositionBatch = (io, socket) => {
  socket.on('trip:position_batch', async (data) => {
    try {
      if (!socket.authenticated) return;
      const tripId = Number(data?.tripId);
      const points = Array.isArray(data?.points) ? data.points : [];
      if (!tripId || points.length === 0) return;

      const trip = await findTripById(tripId);
      if (!trip) return;
      if (Number(trip.owner_id) !== Number(socket.alanyaID)) return;
      if (!policy.OPEN_STATES.has(trip.state)) return;

      // Ordre chronologique : le dernier point traité doit être le plus récent,
      // sinon `trip.last_*` finirait sur une position périmée.
      const tries = points
        .slice(0, MAX_BATCH)
        .map(validPoint)
        .filter(Boolean)
        .sort((a, b) => a.recordedAt - b.recordedAt);

      for (const p of tries) {
        await ingest(io, socket, trip, { ...p, recordedAt: p.recordedAt.toISOString() });
      }
      socket.emit('trip:batch_ack', {
        tripId,
        accepted: tries.map((p) => p.clientSeq).filter((s) => s != null),
      });
    } catch (e) {
      console.error('[Socket trip:position_batch]', e.message);
    }
  });
};

// ---------------------------------------------------------------------------
// trip:claim_device
// ---------------------------------------------------------------------------

/** Reprise explicite depuis un second appareil. L'ancien porteur est prévenu et
 *  arrête son suivi — sans quoi la trace zigzaguerait entre les deux. */
const tripClaimDevice = (io, socket) => {
  socket.on('trip:claim_device', async (data) => {
    try {
      if (!socket.authenticated || !socket.deviceId) return;
      const tripId = Number(data?.tripId);
      if (!tripId) return;

      const trip = await findTripById(tripId);
      if (!trip || Number(trip.owner_id) !== Number(socket.alanyaID)) return;
      if (!policy.OPEN_STATES.has(trip.state)) return;

      const ancien = trip.owner_device;
      if (String(ancien) === String(socket.deviceId)) return;

      await pool.execute('UPDATE trip SET owner_device = ? WHERE id = ?',
        [socket.deviceId, tripId]);
      await logEvent(tripId, 'device_takeover', { actorId: socket.alanyaID });

      // Cibler le compte, pas la room : l'ancien porteur peut très bien ne pas
      // être abonné au flux.
      io.to(`user_${Number(socket.alanyaID)}`)
        .emit('trip:device_revoked', { tripId, deviceId: socket.deviceId });
      socket.emit('trip:state', { tripId, state: trip.state, ownerDevice: socket.deviceId });
    } catch (e) {
      console.error('[Socket trip:claim_device]', e.message);
    }
  });
};

// ---------------------------------------------------------------------------
// trip:signal — GPS coupé, permission retirée, économiseur de batterie
// ---------------------------------------------------------------------------

const MOTIFS = new Set([
  'gps_off', 'permission_denied', 'background_killed', 'battery_saver', 'back',
]);

const tripSignal = (io, socket) => {
  socket.on('trip:signal', async (data) => {
    try {
      if (!socket.authenticated) return;
      const tripId = Number(data?.tripId);
      const reason = String(data?.reason ?? '');
      if (!tripId || !MOTIFS.has(reason)) return;

      const trip = await findTripById(tripId);
      if (!trip || Number(trip.owner_id) !== Number(socket.alanyaID)) return;
      if (!policy.OPEN_STATES.has(trip.state)) return;

      const perdu = reason !== 'back';
      await pool.execute('UPDATE trip SET stale = ? WHERE id = ?',
        [perdu ? 1 : 0, tripId]);
      await logEvent(tripId, perdu ? 'signal_lost' : 'signal_back', {
        actorId: socket.alanyaID,
        meta: { reason },
      });
      // Information, pas alerte : le cercle lit « position indisponible » et
      // l'échéance continue de courir.
      io.to(room(tripId)).emit('trip:signal', { tripId, reason, stale: perdu });
    } catch (e) {
      console.error('[Socket trip:signal]', e.message);
    }
  });
};

// ---------------------------------------------------------------------------
// trip:seen — « j'ai vu », le seul retour d'un destinataire
// ---------------------------------------------------------------------------

const tripSeen = (io, socket) => {
  socket.on('trip:seen', async (data) => {
    try {
      if (!socket.authenticated) return;
      const tripId = Number(data?.tripId);
      if (!tripId) return;

      const [r] = await pool.execute(
        `UPDATE trip_watcher SET seen_at = NOW()
          WHERE trip_id = ? AND alanyaID = ? AND state = 'active' AND seen_at IS NULL`,
        [tripId, socket.alanyaID],
      );
      if (r.affectedRows === 0) return;

      await logEvent(tripId, 'watcher_seen', { actorId: socket.alanyaID });

      const trip = await findTripById(tripId);
      if (!trip) return;
      // Le propriétaire est visé par son compte : « Maman a vu » doit
      // l'atteindre même s'il n'a pas l'écran de suivi ouvert.
      io.to(`user_${Number(trip.owner_id)}`).emit('trip:watcher_seen', {
        tripId,
        alanyaID: Number(socket.alanyaID),
      });
    } catch (e) {
      console.error('[Socket trip:seen]', e.message);
    }
  });
};

module.exports = {
  tripSubscribe,
  tripUnsubscribe,
  tripPosition,
  tripPositionBatch,
  tripClaimDevice,
  tripSignal,
  tripSeen,
  // exportés pour les tests
  validPoint,
  room,
};
