// État en mémoire des trajets ouverts, indexé par tripId.
//
// ⚠ Différence majeure avec `callState` : ici la mémoire n'est PAS autoritaire.
// Un appel qui disparaît du process est un appel perdu ; un trajet, lui, DOIT
// survivre au redémarrage du serveur — c'est une promesse de sûreté. La base
// fait donc foi, et cette map n'est qu'un cache reconstruit paresseusement au
// premier contact, plus un limiteur de débit.
//
// Ce qu'elle porte, et qu'on ne veut pas écrire en base à chaque tic :
//   • la dernière position vue (pour décider s'il faut rediffuser ou persister)
//   • les horodatages de dernière diffusion / dernière écriture
//   • le dernier contact (péremption)
//   • les numéros de séquence déjà reçus (déduplication)
//
// Chaque entrée : { lastPoint, lastBroadcastAt, lastPersistAt, lastSeenAt,
//                   regime, seenSeqs, staleTimer, stale }

const {
  BROADCAST_MIN_S,
  PERSIST_MIN_S,
  staleAfterSeconds,
} = require('../../constants/tripPolicy');

// Une position renvoyée par le battement est identique à la précédente. On ne
// la persiste pas — mais on met quand même à jour « dernier contact », qui est
// justement l'information qu'elle apporte.
const MOVED_MIN_M = 10;

// Fenêtre de déduplication. Au-delà, un numéro de séquence est oublié : un
// trajet long ne doit pas faire grossir la mémoire indéfiniment.
const SEQ_WINDOW = 400;

const _trips = new Map(); // tripId(Number) -> entry

const _key = (tripId) => Number(tripId);

function getEntry(tripId) {
  return _trips.get(_key(tripId)) || null;
}

function ensure(tripId) {
  const k = _key(tripId);
  let e = _trips.get(k);
  if (!e) {
    e = {
      lastPoint: null,
      lastBroadcastAt: 0,
      lastPersistAt: 0,
      lastSeenAt: 0,
      regime: 'nominal',
      seenSeqs: new Set(),
      staleTimer: null,
      stale: false,
      inZoneSince: null,
      arrived: false,
    };
    _trips.set(k, e);
  }
  return e;
}

/** Distance approchée en mètres. Équirectangulaire : l'erreur est négligeable
 *  aux échelles qui nous intéressent, et cela évite une trigonométrie complète
 *  à chaque position reçue. */
function distanceM(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * Un point déjà reçu ? La vidange d'un tampon hors ligne rejoue des points ;
 * la déduplication rend l'opération sans risque.
 */
function isDuplicate(tripId, clientSeq) {
  if (clientSeq == null) return false;
  const e = getEntry(tripId);
  return e ? e.seenSeqs.has(Number(clientSeq)) : false;
}

function rememberSeq(tripId, clientSeq) {
  if (clientSeq == null) return;
  const e = ensure(tripId);
  e.seenSeqs.add(Number(clientSeq));
  if (e.seenSeqs.size > SEQ_WINDOW) {
    // Set conserve l'ordre d'insertion : on évacue les plus anciens.
    const surplus = e.seenSeqs.size - SEQ_WINDOW;
    let i = 0;
    for (const s of e.seenSeqs) {
      if (i++ >= surplus) break;
      e.seenSeqs.delete(s);
    }
  }
}

/**
 * Décide quoi faire d'une position qui arrive. C'est le cœur de la décimation
 * à trois étages : le client a déjà filtré par distance, le serveur décide de
 * la rediffusion et de la persistance.
 *
 * @returns {{broadcast: boolean, persist: boolean, moved: number}}
 */
function admit(tripId, point, now = Date.now()) {
  const e = ensure(tripId);
  const moved = distanceM(e.lastPoint, point);

  const broadcast = now - e.lastBroadcastAt >= BROADCAST_MIN_S * 1000;
  // On ne persiste que si la position a bougé : un trajet à l'arrêt ne doit pas
  // remplir `trip_point` de points identiques.
  const persist =
    now - e.lastPersistAt >= PERSIST_MIN_S * 1000 &&
    (e.lastPoint === null || moved >= MOVED_MIN_M);

  e.lastPoint = point;
  e.lastSeenAt = now;
  e.stale = false;
  if (broadcast) e.lastBroadcastAt = now;
  if (persist) e.lastPersistAt = now;

  return { broadcast, persist, moved };
}

function setRegime(tripId, regime) {
  ensure(tripId).regime = regime || 'nominal';
}

// ---------------------------------------------------------------------------
// Détection d'arrivée
// ---------------------------------------------------------------------------

/**
 * L'utilisateur est-il arrivé ? Trois conditions cumulatives, et une
 * conséquence.
 *
 *   1. être dans le rayon ;
 *   2. y **rester** — l'hystérésis. Passer devant sa rue sans s'arrêter est le
 *      faux positif numéro un ;
 *   3. rouler lentement — le portillon de vitesse.
 *
 * Les relevés trop imprécis ne comptent pas : en canyon urbain, une erreur de
 * 300 m ferait « arriver » quelqu'un qui est encore loin.
 *
 * Et la conséquence, qui n'est pas négociable : **une arrivée détectée ne clôt
 * rien.** Elle pose la question. Le coût d'un faux positif devient une question
 * à balayer, jamais un filet rompu.
 *
 * @returns {boolean} vrai la PREMIÈRE fois que l'hystérésis est satisfaite.
 */
function checkArrival(tripId, point, dest, { radiusM, hysteresisS, maxSpeedKmh, maxAccuracyM }, now = Date.now()) {
  const e = ensure(tripId);
  if (!dest || dest.lat == null || dest.lng == null) return false;
  if (e.arrived) return false;

  // Un relevé trop flou ne peut ni confirmer ni infirmer : on l'ignore, sans
  // remettre le compteur à zéro — sinon une seule mesure imprécise annulerait
  // une minute d'attente légitime.
  if (point.accuracyM != null && point.accuracyM > maxAccuracyM) return false;

  const dedans = distanceM(dest, point) <= radiusM;
  const lent = point.speedKmh == null || point.speedKmh <= maxSpeedKmh;

  if (!dedans || !lent) {
    e.inZoneSince = null;
    return false;
  }

  if (e.inZoneSince == null) {
    e.inZoneSince = now;
    return false;
  }

  if (now - e.inZoneSince >= hysteresisS * 1000) {
    e.arrived = true;
    return true;
  }
  return false;
}

function getRegime(tripId) {
  return getEntry(tripId)?.regime ?? 'nominal';
}

/**
 * Arme la détection de péremption. Le délai dérive du battement du régime en
 * cours — sans rythme attendu, aucun moyen de décider à quel moment un silence
 * devient anormal.
 *
 * ⚠ La péremption n'est PAS une alerte : elle informe que la position n'arrive
 * plus. La chaîne d'échéance continue de tourner, indépendamment.
 */
function armStale(tripId, onStale) {
  const e = ensure(tripId);
  if (e.staleTimer) clearTimeout(e.staleTimer);
  const delayMs = staleAfterSeconds(e.regime) * 1000;
  e.staleTimer = setTimeout(() => {
    const cur = getEntry(tripId);
    if (!cur || cur.stale) return;
    cur.stale = true;
    cur.staleTimer = null;
    try {
      onStale(Number(tripId), cur.lastPoint);
    } catch (err) {
      console.error('[TripState] onStale:', err.message);
    }
  }, delayMs);
  // Ne pas retenir le process : un trajet ne doit pas empêcher un arrêt propre.
  if (e.staleTimer.unref) e.staleTimer.unref();
  return delayMs;
}

function isStale(tripId) {
  return getEntry(tripId)?.stale === true;
}

/** Libère l'entrée. Appelé à la clôture, et au démarrage pour les orphelins. */
function clear(tripId) {
  const e = getEntry(tripId);
  if (e?.staleTimer) clearTimeout(e.staleTimer);
  return _trips.delete(_key(tripId));
}

function size() {
  return _trips.size;
}

/** Uniquement pour les tests : repart d'une mémoire vierge. */
function _reset() {
  for (const e of _trips.values()) {
    if (e.staleTimer) clearTimeout(e.staleTimer);
  }
  _trips.clear();
}

module.exports = {
  getEntry,
  ensure,
  distanceM,
  isDuplicate,
  rememberSeq,
  admit,
  setRegime,
  getRegime,
  checkArrival,
  armStale,
  isStale,
  clear,
  size,
  _reset,
  MOVED_MIN_M,
  SEQ_WINDOW,
};
