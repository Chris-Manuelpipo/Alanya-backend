/**
 * Balayage de la péremption des trajets.
 *
 * Les autres délais du projet passent par `job_queue` ; celui-ci ne le peut
 * pas. `armStale` est rappelé à CHAQUE position GPS reçue — plusieurs fois par
 * minute et par trajet en régime d'alerte. Deux écritures MySQL par position
 * ne tiennent pas, alors que le trajet est justement le volet où les positions
 * affluent.
 *
 * D'où ce renversement : au lieu de N minuteurs (un par trajet) qui se
 * réarment sans cesse, un seul balayage périodique interroge un index
 * d'échéances trié. Réarmer coûte un `ZADD` local ; savoir qui a dépassé son
 * échéance coûte une requête, quel que soit le nombre de trajets.
 *
 * Sous bail : une seule instance balaie, sinon deux serveurs annonceraient
 * chacun la même perte de signal.
 */

const pool = require('../config/db');
const tripState = require('../socket/state/tripState');
const { withLease } = require('./schedulerLease');
const { logEvent } = require('./tripService');
const { getDataClient } = require('../config/redisData');

// 5 s : la péremption la plus courte est de l'ordre de la minute (battement du
// régime × facteur), un balayage à cette cadence n'ajoute donc jamais plus de
// quelques secondes au délai annoncé, tout en restant très bon marché.
const CADENCE_MS = 5 * 1000;

let _timer = null;

/** Ce que faisait le callback `onStale` : on informe, on n'alerte pas. */
async function signalerPerte(io, tripId, lastPoint) {
  try {
    await pool.execute('UPDATE trip SET stale = 1 WHERE id = ?', [tripId]);
    await logEvent(tripId, 'signal_lost', {
      meta: lastPoint ? { lat: lastPoint.lat, lng: lastPoint.lng } : null,
    });
    if (io) io.to(`trip_${tripId}`).emit('trip:stale', { tripId, stale: true });
  } catch (e) {
    console.error('[Trip] signalerPerte:', e.message);
  }
}

async function balayer(io) {
  const echus = await tripState.collectStale();
  for (const { tripId, lastPoint } of echus) {
    await signalerPerte(io, tripId, lastPoint);
  }
  return echus.length;
}

function startTripStaleSweeper(io) {
  // Sans Redis, chaque trajet garde son propre setTimeout dans le process :
  // le balayage n'a alors rien à faire.
  if (!getDataClient()) {
    console.log('[Trip] péremption : minuteurs en mémoire (REDIS_URL absent)');
    return;
  }
  console.log('[Trip] balayage de péremption démarré');
  _timer = setInterval(() => {
    withLease('trip_stale_sweep', () => balayer(io), 30)
      .catch((e) => console.error('[Trip] balayage péremption:', e.message));
  }, CADENCE_MS);
  if (_timer.unref) _timer.unref();
}

function stopTripStaleSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startTripStaleSweeper, stopTripStaleSweeper, balayer, signalerPerte, CADENCE_MS };
