/**
 * Trajets de confiance — rétention et purge de la trace.
 *
 * Le fait survit, le tracé non. Un trajet clos garde son résumé et sa frise
 * d'événements aussi longtemps que la rétention du fait (`tripMonths`) ; ses
 * positions, elles, disparaissent au bout de `pointsHours`. Sans cette purge,
 * `trip_point` deviendrait un registre permanent des déplacements de tous les
 * utilisateurs — ce qu'aucun besoin produit ne justifie.
 *
 * Ce module est volontairement séparé de `tripWorkers` : l'espace
 * d'administration a besoin de compter et de déclencher la purge, pas de tirer
 * la machinerie d'escalade (file de jobs, notifications, socket) avec elle.
 */

const pool = require('../config/db');
const policy = require('../constants/tripPolicy');

/**
 * Prédicat « la trace de ce trajet a dépassé sa rétention », sur un `trip`
 * aliasé `t`. Une seule définition, partagée par la purge et par les compteurs
 * de l'espace d'administration : si les deux divergeaient, l'admin verrait
 * « 0 à purger » sur des traces que le balayage efface quand même.
 *
 *   • `pointsHours` (30 jours) pour un trajet ordinaire ;
 *   • `pointsIncidentDays` si le trajet s'est clos sur un incident — la trace
 *     peut alors être une preuve, et mérite sa propre décision.
 *
 * `ignoreRetention` ne garde que « le trajet est clos » : c'est la purge
 * manuelle, qui efface tout de suite au lieu d'attendre l'échéance. Un trajet
 * en cours n'est JAMAIS concerné — sa trace, c'est le suivi live lui-même, et
 * l'effacer couperait un partage en train de protéger quelqu'un.
 */
const expiredTraceWhere = ({ ignoreRetention = false } = {}) => (
  ignoreRetention
    ? { sql: 't.closed_at IS NOT NULL', params: [] }
    : {
      sql: `t.closed_at IS NOT NULL AND (
              (t.alerted_at IS NULL
               AND t.closed_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
           OR (t.alerted_at IS NOT NULL
               AND t.closed_at < DATE_SUB(NOW(), INTERVAL ? DAY))
        )`,
      params: [policy.RETENTION.pointsHours, policy.RETENTION.pointsIncidentDays],
    }
);

/**
 * Efface la trace des trajets dont la rétention est échue. Renvoie le nombre de
 * points supprimés et le nombre de trajets nouvellement marqués purgés.
 *
 * @param {number|null} tripId   restreint à un trajet, ou `null` pour tous
 * @param {{ignoreRetention?: boolean}} options
 */
const purgeTripPoints = async (tripId = null, options = {}, db = pool) => {
  const cible = expiredTraceWhere(options);
  const filtreId = tripId ? 'AND t.id = ?' : '';
  const params = tripId ? [...cible.params, tripId] : cible.params;

  const [res] = await db.execute(
    `DELETE p FROM trip_point p
       JOIN trip t ON t.id = p.trip_id
      WHERE ${cible.sql} ${filtreId}`,
    params,
  );

  // Le marquage porte EXACTEMENT sur les trajets que le DELETE vient de viser.
  // Marquer plus large — « tous les trajets clos sans horodatage », ce que
  // faisait ce code — estampillait « trace purgée » des trajets clos la veille
  // dont les points étaient encore là : l'app affichait « Trace expirée » sur un
  // trajet parfaitement rejouable, dès qu'un seul point avait été purgé
  // ailleurs dans la nuit.
  const [marques] = await db.execute(
    `UPDATE trip t SET t.points_purged_at = NOW()
      WHERE ${cible.sql} ${filtreId}
        AND t.points_purged_at IS NULL`,
    params,
  );

  return { points: res.affectedRows, trips: marques.affectedRows };
};

/** Purge nocturne complète : la trace, puis les trajets trop vieux. */
const runNightlyTripPurge = async (db = pool) => {
  const { points } = await purgeTripPoints(null, {}, db);
  const [res] = await db.execute(
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

/**
 * Ce qui reste en base, pour l'espace d'administration.
 *
 * ⚠ Comptages seulement. Aucune coordonnée, aucun identifiant de trajet,
 * aucune identité : cet écran sert à savoir combien de traces dorment encore,
 * pas à regarder où les gens sont allés.
 */
const fetchTraceRetentionStats = async (db = pool) => {
  const echu = expiredTraceWhere();
  const clos = expiredTraceWhere({ ignoreRetention: true });

  const [
    [[stockRow]],
    [[echuRow]],
    [[closRow]],
    [[marquesRow]],
  ] = await Promise.all([
    // Tout ce qui est stocké, trajets en cours compris.
    db.execute(
      `SELECT COUNT(*) AS points,
              COUNT(DISTINCT p.trip_id) AS trips,
              MIN(p.recorded_at) AS oldest
         FROM trip_point p`,
    ),
    // Ce que le prochain balayage effacera.
    db.execute(
      `SELECT COUNT(*) AS points, COUNT(DISTINCT p.trip_id) AS trips
         FROM trip_point p JOIN trip t ON t.id = p.trip_id
        WHERE ${echu.sql}`,
      echu.params,
    ),
    // Ce qu'une purge manuelle immédiate effacerait : tous les trajets clos.
    db.execute(
      `SELECT COUNT(*) AS points, COUNT(DISTINCT p.trip_id) AS trips
         FROM trip_point p JOIN trip t ON t.id = p.trip_id
        WHERE ${clos.sql}`,
      clos.params,
    ),
    db.execute(
      `SELECT COUNT(*) AS trips FROM trip WHERE points_purged_at IS NOT NULL`,
    ),
  ]);

  const n = (v) => Number(v) || 0;
  const iso = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  return {
    policy: {
      pointsHours: policy.RETENTION.pointsHours,
      pointsIncidentDays: policy.RETENTION.pointsIncidentDays,
      tripMonths: policy.RETENTION.tripMonths,
    },
    stored: {
      points: n(stockRow?.points),
      trips: n(stockRow?.trips),
      oldestPointAt: iso(stockRow?.oldest),
    },
    expired: { points: n(echuRow?.points), trips: n(echuRow?.trips) },
    closed: { points: n(closRow?.points), trips: n(closRow?.trips) },
    purgedTrips: n(marquesRow?.trips),
  };
};

module.exports = {
  expiredTraceWhere,
  purgeTripPoints,
  runNightlyTripPurge,
  fetchTraceRetentionStats,
};
