// État des trajets ouverts, indexé par tripId.
//
// ⚠ Différence majeure avec `callState` : ici la mémoire n'est PAS autoritaire.
// Un appel qui disparaît du process est un appel perdu ; un trajet, lui, DOIT
// survivre au redémarrage du serveur — c'est une promesse de sûreté. La base
// fait donc foi, et ceci n'est qu'un cache reconstruit paresseusement au
// premier contact, plus un limiteur de débit.
//
// Ce qu'il porte, et qu'on ne veut pas écrire en base à chaque tic :
//   • la dernière position vue (pour décider s'il faut rediffuser ou persister)
//   • les horodatages de dernière diffusion / dernière écriture
//   • le dernier contact (péremption)
//   • les numéros de séquence déjà reçus (déduplication)
//
// ── Répartition (Redis si REDIS_URL, sinon repli mémoire) ──
//
// La péremption ne suit PAS le schéma des autres stores. Ailleurs, un délai
// devient une ligne `job_queue` ; ici c'est exclu : `armStale` est rappelé à
// CHAQUE position reçue — jusqu'à plusieurs fois par minute et par trajet en
// régime d'alerte. Deux écritures MySQL par position GPS ne tiennent pas.
//
// À la place, un index d'échéances (`ZSET` trié par instant de péremption) :
// réarmer coûte un seul `ZADD`, et un balayage périodique unique
// (services/tripStaleWorkers.js) demande « qui a dépassé son échéance ? » en
// une requête. On remplace N minuteurs par un seul, et l'écriture par position
// devient une opération Redis locale au lieu d'un aller-retour vers une base
// distante.

const {
  BROADCAST_MIN_S,
  PERSIST_MIN_S,
  staleAfterSeconds,
} = require('../../constants/tripPolicy');
const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');

// Une position renvoyée par le battement est identique à la précédente. On ne
// la persiste pas — mais on met quand même à jour « dernier contact », qui est
// justement l'information qu'elle apporte.
const MOVED_MIN_M = 10;

// Fenêtre de déduplication. Au-delà, un numéro de séquence est oublié : un
// trajet long ne doit pas faire grossir la mémoire indéfiniment.
const SEQ_WINDOW = 400;

// Filet contre les entrées abandonnées. `clear()` n'est appelé nulle part en
// production (vérifié) : sans expiration, un trajet jamais clos laisserait ses
// clés à vie. Rafraîchi à chaque position, et très au-delà de la durée maximale
// d'un trajet (12 h) pour ne jamais couper un suivi en cours.
const TTL_MS = 36 * 60 * 60 * 1000;

const keyOf = (tripId) => `alanya:tripState:${Number(tripId)}`;
const seqKeyOf = (tripId) => `alanya:tripState:${Number(tripId)}:seq`;
const ECHEANCES = 'alanya:tripState:echeances';

const _key = (tripId) => Number(tripId);

// ── Repli mémoire ───────────────────────────────────────────────────────────

const _trips = new Map();

function _memEnsure(tripId) {
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

// ── Redis ───────────────────────────────────────────────────────────────────

function _depuisHash(h) {
  if (!h || !h.cree) return null;
  const nb = (v, d = 0) => (v == null || v === '' ? d : Number(v));
  let lastPoint = null;
  if (h.lastPoint) { try { lastPoint = JSON.parse(h.lastPoint); } catch { lastPoint = null; } }
  return {
    lastPoint,
    lastBroadcastAt: nb(h.lastBroadcastAt),
    lastPersistAt: nb(h.lastPersistAt),
    lastSeenAt: nb(h.lastSeenAt),
    regime: h.regime || 'nominal',
    stale: h.stale === '1',
    inZoneSince: h.inZoneSince === '' || h.inZoneSince == null ? null : Number(h.inZoneSince),
    arrived: h.arrived === '1',
    // Présent pour que `getTransferTimerFlags`-like et les tests puissent
    // raisonner uniformément : côté Redis il n'y a pas de handle de minuteur.
    staleTimer: null,
    seenSeqs: null,
  };
}

async function _redisEnsure(client, tripId) {
  const cle = keyOf(tripId);
  const h = await client.hGetAll(cle);
  if (h && h.cree) return _depuisHash(h);
  await client.hSet(cle, {
    cree: '1',
    lastBroadcastAt: '0',
    lastPersistAt: '0',
    lastSeenAt: '0',
    regime: 'nominal',
    stale: '0',
    inZoneSince: '',
    arrived: '0',
  });
  await client.pExpire(cle, TTL_MS);
  return _depuisHash(await client.hGetAll(cle));
}

// ── Lectures ────────────────────────────────────────────────────────────────

async function getEntry(tripId) {
  const client = getDataClient();
  if (client) return _depuisHash(await client.hGetAll(keyOf(tripId)));
  return _trips.get(_key(tripId)) || null;
}

async function ensure(tripId) {
  const client = getDataClient();
  if (client) return _redisEnsure(client, tripId);
  return _memEnsure(tripId);
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

// ── Déduplication ───────────────────────────────────────────────────────────

/**
 * Un point déjà reçu ? La vidange d'un tampon hors ligne rejoue des points ;
 * la déduplication rend l'opération sans risque.
 */
async function isDuplicate(tripId, clientSeq) {
  if (clientSeq == null) return false;
  const client = getDataClient();
  if (client) {
    const rang = await client.zScore(seqKeyOf(tripId), String(Number(clientSeq)));
    return rang != null;
  }
  const e = _trips.get(_key(tripId));
  return e ? e.seenSeqs.has(Number(clientSeq)) : false;
}

/**
 * Un ZSET et non un SET : le plafond doit évincer les PLUS ANCIENS numéros.
 * Un SET Redis n'a pas d'ordre — il faudrait tout lire pour choisir quoi
 * supprimer. Le score porte donc l'ordre d'arrivée, et `ZREMRANGEBYRANK`
 * retire le surplus par le bas en une opération.
 */
const REMEMBER_SEQ = `
local n = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
local trop = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[3])
if trop > 0 then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, trop - 1) end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return n
`;

async function rememberSeq(tripId, clientSeq) {
  if (clientSeq == null) return;
  const client = getDataClient();
  if (client) {
    await runScript(client, REMEMBER_SEQ, [seqKeyOf(tripId)],
      [String(Number(clientSeq)), String(Date.now()), String(SEQ_WINDOW), String(TTL_MS)]);
    return;
  }
  const e = _memEnsure(tripId);
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

// ── Décimation ──────────────────────────────────────────────────────────────

/**
 * Décide quoi faire d'une position qui arrive. C'est le cœur de la décimation
 * à trois étages : le client a déjà filtré par distance, le serveur décide de
 * la rediffusion et de la persistance.
 *
 * Pas de verrou : un seul appareil émet pour un trajet donné (`trip.owner_device`),
 * et ce cache assume déjà la perte d'un tic — le fichier le dit en tête. Une
 * position dupliquée coûterait au pire une rediffusion de trop, jamais une
 * décision fausse.
 *
 * @returns {{broadcast: boolean, persist: boolean, moved: number}}
 */
async function admit(tripId, point, now = Date.now()) {
  const client = getDataClient();
  const e = client ? await _redisEnsure(client, tripId) : _memEnsure(tripId);
  const moved = distanceM(e.lastPoint, point);

  const broadcast = now - e.lastBroadcastAt >= BROADCAST_MIN_S * 1000;
  // On ne persiste que si la position a bougé : un trajet à l'arrêt ne doit pas
  // remplir `trip_point` de points identiques.
  const persist =
    now - e.lastPersistAt >= PERSIST_MIN_S * 1000 &&
    (e.lastPoint === null || moved >= MOVED_MIN_M);

  if (client) {
    const champs = {
      lastPoint: JSON.stringify(point),
      lastSeenAt: String(now),
      stale: '0',
    };
    if (broadcast) champs.lastBroadcastAt = String(now);
    if (persist) champs.lastPersistAt = String(now);
    await client.hSet(keyOf(tripId), champs);
    await client.pExpire(keyOf(tripId), TTL_MS);
    return { broadcast, persist, moved };
  }

  e.lastPoint = point;
  e.lastSeenAt = now;
  e.stale = false;
  if (broadcast) e.lastBroadcastAt = now;
  if (persist) e.lastPersistAt = now;
  return { broadcast, persist, moved };
}

async function setRegime(tripId, regime) {
  const client = getDataClient();
  if (client) {
    await _redisEnsure(client, tripId);
    await client.hSet(keyOf(tripId), 'regime', regime || 'nominal');
    return;
  }
  _memEnsure(tripId).regime = regime || 'nominal';
}

async function getRegime(tripId) {
  return (await getEntry(tripId))?.regime ?? 'nominal';
}

// ── Détection d'arrivée ─────────────────────────────────────────────────────

/**
 * Bascule `arrived` seulement si elle ne l'était pas — l'arrivée ne doit être
 * signalée qu'une fois. C'est la seule transition de ce store qui ne tolère
 * pas la duplication : un second signal rouvrirait la question de l'arrivée à
 * quelqu'un qui y a déjà répondu.
 */
const MARQUER_ARRIVEE = `
if redis.call('HGET', KEYS[1], 'arrived') == '1' then return 0 end
redis.call('HSET', KEYS[1], 'arrived', '1')
return 1
`;

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
async function checkArrival(tripId, point, dest, { radiusM, hysteresisS, maxSpeedKmh, maxAccuracyM }, now = Date.now()) {
  const client = getDataClient();
  const e = client ? await _redisEnsure(client, tripId) : _memEnsure(tripId);
  if (!dest || dest.lat == null || dest.lng == null) return false;
  if (e.arrived) return false;

  // Un relevé trop flou ne peut ni confirmer ni infirmer : on l'ignore, sans
  // remettre le compteur à zéro — sinon une seule mesure imprécise annulerait
  // une minute d'attente légitime.
  if (point.accuracyM != null && point.accuracyM > maxAccuracyM) return false;

  const dedans = distanceM(dest, point) <= radiusM;
  const lent = point.speedKmh == null || point.speedKmh <= maxSpeedKmh;

  if (!dedans || !lent) {
    if (client) await client.hSet(keyOf(tripId), 'inZoneSince', '');
    else e.inZoneSince = null;
    return false;
  }

  if (e.inZoneSince == null) {
    if (client) await client.hSet(keyOf(tripId), 'inZoneSince', String(now));
    else e.inZoneSince = now;
    return false;
  }

  if (now - e.inZoneSince >= hysteresisS * 1000) {
    if (client) {
      const gagnant = await runScript(client, MARQUER_ARRIVEE, [keyOf(tripId)], []);
      return Number(gagnant) === 1;
    }
    e.arrived = true;
    return true;
  }
  return false;
}

// ── Péremption ──────────────────────────────────────────────────────────────

/**
 * Arme la détection de péremption. Le délai dérive du battement du régime en
 * cours — sans rythme attendu, aucun moyen de décider à quel moment un silence
 * devient anormal.
 *
 * ⚠ La péremption n'est PAS une alerte : elle informe que la position n'arrive
 * plus. La chaîne d'échéance continue de tourner, indépendamment.
 *
 * Côté Redis, `onStale` est ignoré : c'est le balayage périodique
 * (services/tripStaleWorkers.js) qui déclenche la cascade. Cette fonction ne
 * fait alors qu'inscrire une échéance dans l'index — un seul `ZADD`, ce qui
 * permet de la rappeler à chaque position sans coût notable.
 */
async function armStale(tripId, onStale) {
  const client = getDataClient();
  if (client) {
    const e = await _redisEnsure(client, tripId);
    const delayMs = staleAfterSeconds(e.regime) * 1000;
    await client.zAdd(ECHEANCES, { score: Date.now() + delayMs, value: String(Number(tripId)) });
    return delayMs;
  }
  const e = _memEnsure(tripId);
  if (e.staleTimer) clearTimeout(e.staleTimer);
  const delayMs = staleAfterSeconds(e.regime) * 1000;
  e.staleTimer = setTimeout(() => {
    const cur = _trips.get(_key(tripId));
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

async function isStale(tripId) {
  return (await getEntry(tripId))?.stale === true;
}

/**
 * Relève les trajets dont l'échéance est dépassée, les marque périmés, et les
 * retire de l'index — en une passe.
 *
 * Appelé par le balayage périodique. Un trajet déjà marqué périmé n'est pas
 * rendu deux fois : c'est la garantie « une seule notification par silence ».
 *
 * @returns {Array<{tripId: number, lastPoint: object|null}>}
 */
async function collectStale(now = Date.now()) {
  const client = getDataClient();
  if (!client) return [];
  const echus = await client.zRangeByScore(ECHEANCES, 0, now);
  const sortis = [];
  for (const brut of echus) {
    // Le retrait de l'index EST la prise de possession : `ZREM` rend 1 à
    // celui qui a effectivement retiré le membre, 0 aux autres. Relever
    // puis retirer en deux gestes laissait deux balayages simultanés — ou
    // deux instances — annoncer la même perte de signal au cercle du trajet.
    const pris = await client.zRem(ECHEANCES, brut);
    if (!pris) continue;

    const tripId = Number(brut);
    const e = _depuisHash(await client.hGetAll(keyOf(tripId)));
    if (!e || e.stale) continue;
    await client.hSet(keyOf(tripId), 'stale', '1');
    sortis.push({ tripId, lastPoint: e.lastPoint });
  }
  return sortis;
}

/** Libère l'entrée. Appelé à la clôture, et au démarrage pour les orphelins. */
async function clear(tripId) {
  const client = getDataClient();
  if (client) {
    await client.zRem(ECHEANCES, String(Number(tripId)));
    const n = await client.del([keyOf(tripId), seqKeyOf(tripId)]);
    return n > 0;
  }
  const e = _trips.get(_key(tripId));
  if (e?.staleTimer) clearTimeout(e.staleTimer);
  return _trips.delete(_key(tripId));
}

async function size() {
  const client = getDataClient();
  if (client) return client.zCard(ECHEANCES);
  return _trips.size;
}

/** Uniquement pour les tests du repli mémoire : repart d'une mémoire vierge. */
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
  collectStale,
  clear,
  size,
  _reset,
  MOVED_MIN_M,
  SEQ_WINDOW,
  TTL_MS,
};
