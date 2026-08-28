/**
 * Propriété média par appareil pour un appel / session / room.
 * Complète callState / callSessions / pendingCalls (granularité device).
 *
 * Clé : callId | sessionId | roomId (string)
 * Valeur : Map<userId, { activeDeviceId, activeSocketId, claimedAt, state }>
 *
 * states: calling | ringing | active | left
 *
 * Deux implémentations : Redis (HASH par clé, field=userId — partagé entre
 * instances pm2) si REDIS_URL est configuré, sinon repli sur des Map locales
 * au process (comportement mono-instance identique à avant l'intégration
 * Redis). Le choix se fait à chaque appel via getDataClient().
 *
 * `tryClaim` est LE cas d'usage qui justifie un script Lua plutôt qu'un
 * simple GET+SET : deux devices du même compte peuvent décrocher « en même
 * temps » sur deux instances différentes. Un GET+SET naïf laisserait les deux
 * gagner silencieusement (double flux média, le perdant ne recevant jamais le
 * call_ended qui devrait fermer son CallKit) — voir callDeviceOwnership.race.test.js.
 */

const { normalizeDeviceId } = require('../../utils/deviceId');
const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');

const keyOf = (key) => `alanya:callDeviceOwnership:${key}`;

// Filet de sécurité : ces entrées sont censées être libérées par les chemins de
// sortie, mais un process qui meurt en cours d'appel n'en libère aucune. Sans
// expiration, elles s'accumulaient indéfiniment — et une entrée orpheline
// interdit de rejoindre depuis un autre appareil, définitivement. Six heures :
// très au-delà de tout appel, assez court pour que rien ne s'entasse.
const TTL_MS = 6 * 60 * 60 * 1000;

async function _ecrire(client, key, userId, entry) {
  await client.hSet(keyOf(key), String(Number(userId)), JSON.stringify(entry));
  await client.pExpire(keyOf(key), TTL_MS);
}

// ── Repli mémoire (key -> Map<userId, entry>) ───────────────────────────────
const _byKey = new Map();

function _key(k) {
  if (k == null || k === '') return null;
  return String(k);
}

function _userMap(key) {
  const k = _key(key);
  if (!k) return null;
  let m = _byKey.get(k);
  if (!m) {
    m = new Map();
    _byKey.set(k, m);
  }
  return m;
}

function _memGetEntry(key, userId) {
  const m = _byKey.get(_key(key));
  if (!m) return null;
  return m.get(Number(userId)) ?? null;
}

function _memSetCalling(key, userId, { activeDeviceId, activeSocketId }) {
  const m = _userMap(key);
  if (!m) return false;
  const did = normalizeDeviceId(activeDeviceId);
  if (!did) return false;
  m.set(Number(userId), {
    activeDeviceId: did,
    activeSocketId: activeSocketId ?? null,
    claimedAt: Date.now(),
    state: 'calling',
  });
  return true;
}

function _memSetActive(key, userId, { activeDeviceId, activeSocketId }) {
  const m = _userMap(key);
  if (!m) return false;
  const did = normalizeDeviceId(activeDeviceId);
  if (!did) return false;
  m.set(Number(userId), {
    activeDeviceId: did,
    activeSocketId: activeSocketId ?? null,
    claimedAt: Date.now(),
    state: 'active',
  });
  return true;
}

function _memRing(key, userId) {
  const m = _userMap(key);
  if (!m) return false;
  m.set(Number(userId), {
    activeDeviceId: null,
    activeSocketId: null,
    claimedAt: null,
    state: 'ringing',
  });
  return true;
}

function _memTryClaim(key, userId, deviceId, socketId) {
  const k = _key(key);
  if (!k) return { ok: false, reason: 'NO_SESSION' };
  const m = _byKey.get(k);
  if (!m) return { ok: false, reason: 'NO_SESSION' };
  const uid = Number(userId);
  const did = normalizeDeviceId(deviceId);
  if (!did) return { ok: false, reason: 'DEVICE_ID_REQUIRED' };

  const entry = m.get(uid);
  if (!entry) return { ok: false, reason: 'NO_SESSION' };

  if (entry.state === 'active' && entry.activeDeviceId) {
    if (entry.activeDeviceId === did) {
      entry.activeSocketId = socketId ?? entry.activeSocketId;
      return { ok: true, entry, alreadyOwner: true };
    }
    return { ok: false, reason: 'CALL_ANSWERED_ELSEWHERE', entry };
  }

  if (entry.state === 'left') {
    return { ok: false, reason: 'CALL_LEFT' };
  }

  entry.activeDeviceId = did;
  entry.activeSocketId = socketId ?? null;
  entry.claimedAt = Date.now();
  entry.state = 'active';
  return { ok: true, entry, alreadyOwner: false };
}

function _memReleaseUser(key, userId) {
  const m = _byKey.get(_key(key));
  if (!m) return;
  const entry = m.get(Number(userId));
  if (entry) {
    entry.state = 'left';
    entry.activeDeviceId = null;
    entry.activeSocketId = null;
  }
}

function _memRelease(key) {
  const k = _key(key);
  if (k) _byKey.delete(k);
}

// ── Redis ────────────────────────────────────────────────────────────────

async function _redisGetEntry(client, key, userId) {
  const raw = await client.hGet(keyOf(key), String(Number(userId)));
  return raw ? JSON.parse(raw) : null;
}

async function _redisSetCalling(client, key, userId, { activeDeviceId, activeSocketId }) {
  const did = normalizeDeviceId(activeDeviceId);
  if (!did) return false;
  const entry = {
    activeDeviceId: did,
    activeSocketId: activeSocketId ?? null,
    claimedAt: Date.now(),
    state: 'calling',
  };
  await _ecrire(client, key, userId, entry);
  return true;
}

async function _redisSetActive(client, key, userId, { activeDeviceId, activeSocketId }) {
  const did = normalizeDeviceId(activeDeviceId);
  if (!did) return false;
  const entry = {
    activeDeviceId: did,
    activeSocketId: activeSocketId ?? null,
    claimedAt: Date.now(),
    state: 'active',
  };
  await _ecrire(client, key, userId, entry);
  return true;
}

async function _redisRing(client, key, userId) {
  const entry = { activeDeviceId: null, activeSocketId: null, claimedAt: null, state: 'ringing' };
  await _ecrire(client, key, userId, entry);
  return true;
}

// Rejoue exactement _memTryClaim en une seule opération atomique côté serveur
// Redis — voir le commentaire d'en-tête du fichier.
const TRY_CLAIM_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return cjson.encode({ok=false, reason='NO_SESSION'}) end
local entry = cjson.decode(raw)
if entry.state == 'active' and entry.activeDeviceId then
  if entry.activeDeviceId == ARGV[2] then
    entry.activeSocketId = ARGV[3]
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
    return cjson.encode({ok=true, alreadyOwner=true, entry=entry})
  end
  return cjson.encode({ok=false, reason='CALL_ANSWERED_ELSEWHERE', entry=entry})
end
if entry.state == 'left' then return cjson.encode({ok=false, reason='CALL_LEFT'}) end
entry.activeDeviceId = ARGV[2]
entry.activeSocketId = ARGV[3]
entry.claimedAt = tonumber(ARGV[4])
entry.state = 'active'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
return cjson.encode({ok=true, alreadyOwner=false, entry=entry})
`;

async function _redisTryClaim(client, key, userId, deviceId, socketId) {
  const k = _key(key);
  if (!k) return { ok: false, reason: 'NO_SESSION' };
  const did = normalizeDeviceId(deviceId);
  if (!did) return { ok: false, reason: 'DEVICE_ID_REQUIRED' };
  const raw = await runScript(
    client,
    TRY_CLAIM_SCRIPT,
    [keyOf(k)],
    [String(Number(userId)), did, socketId ?? '', Date.now()],
  );
  const result = JSON.parse(raw);
  if (result.entry && result.entry.activeSocketId === '') result.entry.activeSocketId = null;
  return result;
}

async function _redisReleaseUser(client, key, userId) {
  const entry = await _redisGetEntry(client, key, userId);
  if (!entry) return;
  entry.state = 'left';
  entry.activeDeviceId = null;
  entry.activeSocketId = null;
  await _ecrire(client, key, userId, entry);
}

async function _redisRelease(client, key) {
  const k = _key(key);
  if (k) await client.del(keyOf(k));
}

// ── API publique (inchangée) ────────────────────────────────────────────────

async function getEntry(key, userId) {
  const client = getDataClient();
  if (client) return _redisGetEntry(client, key, userId);
  return _memGetEntry(key, userId);
}

async function getActiveDeviceId(key, userId) {
  const entry = await getEntry(key, userId);
  return entry?.activeDeviceId ?? null;
}

/** Enregistre le caller au démarrage (call_user). */
async function setCalling(key, userId, opts) {
  const client = getDataClient();
  if (client) return _redisSetCalling(client, key, userId, opts);
  return _memSetCalling(key, userId, opts);
}

/** Callee en sonnerie (pas encore de device actif). */
async function ring(key, userId) {
  const client = getDataClient();
  if (client) return _redisRing(client, key, userId);
  return _memRing(key, userId);
}

/**
 * Reprise directe d'un ownership déjà établi ailleurs (ex. migration d'un
 * originCallId vers une nouvelle session) — écrit state='active' d'emblée,
 * sans repasser par tryClaim (aucune contention : le device était déjà
 * propriétaire côté source).
 */
async function setActive(key, userId, opts) {
  const client = getDataClient();
  if (client) return _redisSetActive(client, key, userId, opts);
  return _memSetActive(key, userId, opts);
}

/**
 * Claim atomique : premier device qui gagne.
 * N'invente jamais d'entrée : la session doit exister (ring/setCalling).
 * @returns {{ ok: boolean, reason?: string, entry?: object, alreadyOwner?: boolean }}
 */
async function tryClaim(key, userId, deviceId, socketId) {
  const client = getDataClient();
  if (client) return _redisTryClaim(client, key, userId, deviceId, socketId);
  return _memTryClaim(key, userId, deviceId, socketId);
}

async function isOwnerDevice(key, userId, deviceId) {
  const did = normalizeDeviceId(deviceId);
  if (!did) return false;
  const entry = await getEntry(key, userId);
  return !!(entry && entry.activeDeviceId === did && entry.state !== 'left');
}

async function isOwnerSocket(key, userId, socketId) {
  const entry = await getEntry(key, userId);
  if (!entry || !socketId) return false;
  return entry.activeSocketId === socketId && entry.state !== 'left';
}

/**
 * Oublie l'entrée d'un utilisateur, au lieu de la marquer « left ».
 *
 * `releaseUser` pose l'état `left`, que `tryClaim` refuse ensuite (`CALL_LEFT`).
 * C'est la bonne sémantique pour un appel 1-à-1, où partir est définitif. Pour
 * une salle de groupe ou une session à trois, on peut sortir puis revenir : y
 * laisser un `left` remplacerait simplement un refus par un autre. L'entrée
 * disparaît donc, et une nouvelle jonction repasse par `ring` puis `tryClaim`.
 */
async function forget(key, userId) {
  const k = _key(key);
  if (!k || userId == null) return;
  const client = getDataClient();
  if (client) {
    await client.hDel(keyOf(k), String(Number(userId)));
    return;
  }
  _byKey.get(k)?.delete(Number(userId));
}

async function releaseUser(key, userId) {
  const client = getDataClient();
  if (client) return _redisReleaseUser(client, key, userId);
  return _memReleaseUser(key, userId);
}

async function release(key) {
  const client = getDataClient();
  if (client) return _redisRelease(client, key);
  return _memRelease(key);
}

/** Réservé aux tests du repli mémoire — le chemin Redis gère son propre nettoyage. */
function _reset() {
  _byKey.clear();
}

module.exports = {
  setCalling,
  setActive,
  ring,
  tryClaim,
  getEntry,
  getActiveDeviceId,
  isOwnerDevice,
  isOwnerSocket,
  releaseUser,
  forget,
  release,
  _reset,
};
