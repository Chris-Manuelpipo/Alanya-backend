/**
 * Trajets de confiance — l'échéance et l'escalade.
 *
 * **C'est ici que vit la promesse du volet.** Le flux de positions est un
 * confort ; ce fichier est la garantie : « si personne ne confirme avant 21:55,
 * le cercle est prévenu ». Il ne dépend ni du GPS, ni du réseau du téléphone,
 * ni du système d'exploitation — seulement d'une ligne dans `job_queue` et
 * d'une horloge serveur.
 *
 * L'escalade tient le cercle à l'écart aussi longtemps que possible :
 *
 *   T−5 min  eta_soon       silencieux, PROPRIÉTAIRE SEUL
 *   T        eta_due        état awaiting_confirm, notification au propriétaire
 *   T+3, T+7 reminder       relances, toujours au propriétaire seul
 *   T+10     grace_expired  ALERTE au cercle, avec la dernière position
 *
 * En deçà de dix minutes de grâce, chaque embouteillage devient une alerte, et
 * le cercle apprend à ne plus les ouvrir. C'est le vrai mode de défaillance de
 * ce genre de produit : pas l'alerte manquée, l'alerte qu'on ignore.
 */

const pool = require('../config/db');
const { enqueue, registerJobHandler } = require('./jobQueue');
const policy = require('../constants/tripPolicy');
const {
  findTripById,
  loadWatchers,
  logEvent,
  updateTripCards,
} = require('./tripService');

const KINDS = [
  'trip_eta_soon',
  'trip_eta_due',
  'trip_reminder',
  'trip_grace_expired',
  'trip_max_duration',
  'trip_no_watcher',
];

const dedupe = (tripId) => `trip_${Number(tripId)}`;

// Injecté par server.js : les jobs tournent hors de toute requête, ils n'ont
// donc pas accès à `req.app.get('io')`.
let _io = null;
const setIo = (io) => { _io = io; };

// ---------------------------------------------------------------------------
// Armement
// ---------------------------------------------------------------------------

/**
 * Désarme toutes les échéances d'un trajet.
 *
 * ⚠ Indispensable avant tout ré-armement. `enqueue` fait
 * `ON DUPLICATE KEY UPDATE id = id` et **renvoie `null` en silence** si la clé
 * de déduplication existe déjà : prolonger un trajet sans supprimer d'abord
 * *paraîtrait* fonctionner, et l'alerte partirait à l'heure initiale.
 */
const disarm = async (tripId, executor = pool) => {
  await executor.execute(
    `DELETE FROM job_queue WHERE dedupe_key = ? AND kind IN (${KINDS.map(() => '?').join(',')})`,
    [dedupe(tripId), ...KINDS],
  );
};

/** Arme la chaîne complète pour un trajet, à partir de son `eta_at`. */
const arm = async (trip) => {
  const tripId = Number(trip.id);
  await disarm(tripId);

  const key = dedupe(tripId);
  const eta = trip.eta_at ? new Date(trip.eta_at) : null;

  if (eta) {
    const soon = new Date(eta.getTime() - policy.CONTRACT.etaSoonMin * 60_000);
    // Un trajet très court peut avoir un « bientôt » déjà passé : on ne l'arme
    // pas plutôt que de le déclencher immédiatement.
    if (soon > new Date()) {
      await enqueue('trip_eta_soon', { tripId }, { dedupeKey: key, runAfter: soon });
    }
    await enqueue('trip_eta_due', { tripId }, { dedupeKey: key, runAfter: eta });
  }

  const plafond = new Date(
    new Date(trip.started_at).getTime() + Number(trip.max_duration_h) * 3600_000,
  );
  await enqueue('trip_max_duration', { tripId },
    { dedupeKey: key, runAfter: plafond });
};

/** Clôture : plus rien ne doit se déclencher. */
const disarmAll = disarm;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Applique un changement d'état et le propage partout où il doit aller.
 *
 * La règle du volet : la room `trip_<id>` ne porte que le mouvement. L'état,
 * lui, part vers les **comptes** — un destinataire dont aucun appareil n'est
 * abonné au flux doit quand même être prévenu.
 */
const transition = async (tripId, state, { reason = null, actorId = null } = {}) => {
  const terminal = policy.TERMINAL_STATES.has(state);
  await pool.execute(
    `UPDATE trip
        SET state = ?,
            prompted_at = CASE WHEN ? = 'awaiting_confirm' AND prompted_at IS NULL
                               THEN NOW() ELSE prompted_at END,
            alerted_at  = CASE WHEN ? IN ('alert','sos') AND alerted_at IS NULL
                               THEN NOW() ELSE alerted_at END,
            closed_at   = CASE WHEN ? THEN NOW() ELSE closed_at END,
            close_reason = CASE WHEN ? THEN ? ELSE close_reason END
      WHERE id = ?`,
    [state, state, state, terminal ? 1 : 0, terminal ? 1 : 0, reason, tripId],
  );

  const trip = await findTripById(tripId);
  if (!trip) return null;

  await logEvent(tripId, _eventKind(state), { actorId, meta: reason ? { reason } : null });
  await updateTripCards(trip, { io: _io });

  if (_io) {
    const watchers = await loadWatchers(tripId);
    const cibles = [
      `user_${Number(trip.owner_id)}`,
      ...watchers.map((w) => `user_${w.alanyaID}`),
    ];
    const payload = {
      tripId: Number(tripId),
      state,
      closeReason: reason,
      lastPoint: trip.last_at == null ? null : {
        lat: Number(trip.last_lat),
        lng: Number(trip.last_lng),
        accuracyM: trip.last_acc_m == null ? null : Number(trip.last_acc_m),
        recordedAt: trip.last_at,
      },
    };
    // Une alerte porte son propre événement : les clients lui réservent un
    // traitement plein écran, distinct d'un simple changement d'état.
    const evenement = policy.ALERT_STATES.has(state)
      ? 'trip:alert'
      : (terminal ? 'trip:closed' : 'trip:state');
    _io.to(cibles).emit(evenement, payload);
  }

  if (terminal) await disarmAll(tripId);
  return trip;
};

const _eventKind = (state) => ({
  awaiting_confirm: 'eta_due',
  alert: 'alerted',
  sos: 'sos',
  closed_confirmed: 'confirmed',
  closed_cancelled: 'closed',
  closed_expired: 'closed',
  closed_unwatched: 'closed',
}[state] || 'closed');

// ---------------------------------------------------------------------------
// Les handlers
// ---------------------------------------------------------------------------

/** Chaque handler relit l'état : la file est *at-least-once*, un job peut se
 *  déclencher après la clôture — reprise après incident, orphelin récupéré. */
const vivant = async (tripId, ...etatsAdmis) => {
  const trip = await findTripById(tripId);
  if (!trip) return null;
  if (!policy.OPEN_STATES.has(trip.state)) return null;
  if (etatsAdmis.length && !etatsAdmis.includes(trip.state)) return null;
  return trip;
};

function registerTripJobHandlers() {
  // T−5 : silencieux, propriétaire seul. Il ne se passe rien côté cercle.
  registerJobHandler('trip_eta_soon', async ({ tripId }) => {
    const trip = await vivant(tripId, 'active');
    if (!trip || !_io) return;
    _io.to(`user_${Number(trip.owner_id)}`).emit('trip:eta_soon', {
      tripId: Number(tripId),
      etaAt: trip.eta_at,
    });
  });

  // T : l'échéance. On passe en « à confirmer » et on arme la grâce ET les
  // relances — toujours vers le propriétaire seul.
  registerJobHandler('trip_eta_due', async ({ tripId }) => {
    const trip = await vivant(tripId, 'active');
    if (!trip) return;

    await transition(tripId, 'awaiting_confirm');

    const key = dedupe(tripId);
    const base = Date.now();
    for (const offset of policy.CONTRACT.reminderOffsetsMin) {
      if (offset === 0) continue; // la transition vaut première relance
      await enqueue('trip_reminder', { tripId, offset },
        { dedupeKey: `${key}_r${offset}`, runAfter: new Date(base + offset * 60_000) });
    }
    await enqueue('trip_grace_expired', { tripId }, {
      dedupeKey: key,
      runAfter: new Date(base + Number(trip.grace_minutes) * 60_000),
    });
  });

  registerJobHandler('trip_reminder', async ({ tripId, offset }) => {
    const trip = await vivant(tripId, 'awaiting_confirm');
    if (!trip || !_io) return;
    _io.to(`user_${Number(trip.owner_id)}`).emit('trip:reminder', {
      tripId: Number(tripId),
      offsetMin: offset,
    });
  });

  // T+grâce : le seul job qui parle au cercle.
  registerJobHandler('trip_grace_expired', async ({ tripId }) => {
    const trip = await vivant(tripId, 'awaiting_confirm');
    if (!trip) return;
    await transition(tripId, 'alert', { reason: 'no_confirmation' });
  });

  // Plafond dur. Un trajet n'est pas un traceur permanent : si l'échéance a
  // déjà produit une alerte, on solde ; sinon on pose la question.
  registerJobHandler('trip_max_duration', async ({ tripId }) => {
    const trip = await vivant(tripId);
    if (!trip) return;
    if (policy.ALERT_STATES.has(trip.state)) {
      await transition(tripId, 'closed_expired', { reason: 'max_duration' });
    } else {
      await transition(tripId, 'awaiting_confirm');
    }
  });

  // Plus aucun destinataire : un trajet sans témoin n'est plus de la sécurité,
  // c'est un traceur personnel. On clôt plutôt que de continuer en silence.
  registerJobHandler('trip_no_watcher', async ({ tripId }) => {
    const trip = await vivant(tripId);
    if (!trip) return;
    const restants = await loadWatchers(tripId);
    if (restants.length > 0) return;
    await transition(tripId, 'closed_unwatched', { reason: 'no_watcher' });
  });

  // Purge de la trace. Le fait survit, le tracé non.
  registerJobHandler('trip_points_purge', async ({ tripId }) => {
    await purgeTripPoints(tripId);
  });
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

/**
 * Efface la trace d'un trajet clos. Deux durées :
 *   • 24 h pour un trajet ordinaire — un registre permanent des déplacements de
 *     tous les utilisateurs n'est justifié par aucun besoin produit ;
 *   • 30 jours si le trajet s'est clos sur un incident — la trace peut alors
 *     être une preuve.
 */
const purgeTripPoints = async (tripId = null) => {
  const heures = policy.RETENTION.pointsHours;
  const jours = policy.RETENTION.pointsIncidentDays;

  const [res] = await pool.execute(
    `DELETE p FROM trip_point p
       JOIN trip t ON t.id = p.trip_id
      WHERE t.closed_at IS NOT NULL
        ${tripId ? 'AND t.id = ?' : ''}
        AND (
              (t.alerted_at IS NULL
               AND t.closed_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
           OR (t.alerted_at IS NOT NULL
               AND t.closed_at < DATE_SUB(NOW(), INTERVAL ? DAY))
        )`,
    tripId ? [tripId, heures, jours] : [heures, jours],
  );

  if (res.affectedRows > 0) {
    await pool.execute(
      `UPDATE trip SET points_purged_at = NOW()
        WHERE closed_at IS NOT NULL AND points_purged_at IS NULL
          ${tripId ? 'AND id = ?' : ''}`,
      tripId ? [tripId] : [],
    );
  }
  return res.affectedRows;
};

/** Purge nocturne complète : la trace, puis les trajets trop vieux. */
const runNightlyTripPurge = async () => {
  const points = await purgeTripPoints();
  const [res] = await pool.execute(
    `DELETE FROM trip
      WHERE closed_at IS NOT NULL
        AND closed_at < DATE_SUB(NOW(), INTERVAL ? MONTH)`,
    [policy.RETENTION.tripMonths],
  );
  if (points || res.affectedRows) {
    console.log(`[Trips] purge : ${points} points, ${res.affectedRows} trajets`);
  }
  return { points, trips: res.affectedRows };
};

module.exports = {
  registerTripJobHandlers,
  setIo,
  arm,
  disarm,
  disarmAll,
  transition,
  purgeTripPoints,
  runNightlyTripPurge,
  dedupe,
  KINDS,
};
