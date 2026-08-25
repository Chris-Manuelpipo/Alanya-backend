/**
 * Présence live meeting par appareil (distincte de la table SQL participant).
 * meetingId -> Map<userId, { activeDeviceId, activeSocketId, joinedAt, graceArmedAt }>
 *
 * Deux implémentations : Redis (HASH par réunion, field=userId — partagé
 * entre instances pm2) si REDIS_URL est configuré, sinon repli sur des Map
 * locales au process (comportement mono-instance identique à avant).
 *
 * `tryJoin` est le pendant réunion de callDeviceOwnership.tryClaim : sans
 * script Lua, deux appareils du même compte rejoignant « en même temps » sur
 * deux instances liraient tous deux « personne n'a la place » avant qu'aucun
 * n'écrive, recevraient tous deux ok:true, et le perdant garderait un flux
 * WebRTC muet en apparence connecté (le routage via getActiveDeviceId ne
 * parlant qu'au dernier écrivain).
 *
 * Timer de grâce : le handle setTimeout du repli mémoire devient une ligne
 * job_queue côté Redis (voir src/services/meetingWorkers.js), la cascade
 * d'expiration étant partagée par les deux chemins.
 */

const { normalizeDeviceId } = require('../../utils/deviceId');
const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');
const { enqueue, cancelByDedupeKey } = require('../../services/jobQueue');

const OWNER_GRACE_MS = 15 * 1000;

const GRACE_KIND = 'meeting_disconnect_grace';
const dedupe = (meetingId, userId) => `meeting_presence_${Number(meetingId)}_${Number(userId)}`;
const keyOf = (meetingId) => `alanya:meetingDevicePresence:${Number(meetingId)}`;

function _mid(meetingId) {
  const n = Number(meetingId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Repli mémoire ───────────────────────────────────────────────────────────
const _byMeeting = new Map();

function _memGet(meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return null;
  return _byMeeting.get(mid)?.get(Number(userId)) ?? null;
}

function _memTryJoin(mid, uid, did, socketId) {
  let m = _byMeeting.get(mid);
  if (!m) {
    m = new Map();
    _byMeeting.set(mid, m);
  }

  const existing = m.get(uid);
  if (existing?.reconnectGraceTimer) {
    clearTimeout(existing.reconnectGraceTimer);
    existing.reconnectGraceTimer = null;
  }

  if (existing && existing.activeDeviceId && existing.activeDeviceId !== did) {
    return { ok: false, code: 'ACCOUNT_ALREADY_IN_MEETING' };
  }

  const resumed = !!(existing && existing.activeDeviceId === did);
  m.set(uid, {
    activeDeviceId: did,
    activeSocketId: socketId ?? null,
    joinedAt: existing?.joinedAt ?? Date.now(),
    reconnectGraceTimer: null,
    graceArmedAt: null,
  });
  return { ok: true, resumed };
}

function _memLeave(meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  const m = _byMeeting.get(mid);
  if (!m) return;
  const uid = Number(userId);
  const entry = m.get(uid);
  if (entry?.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
  m.delete(uid);
  if (m.size === 0) _byMeeting.delete(mid);
}

function _memArmDisconnectGrace(meetingId, userId, onExpire, ms) {
  const entry = _memGet(meetingId, userId);
  if (!entry) return null;
  if (entry.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
  entry.graceArmedAt = Date.now();
  entry.reconnectGraceTimer = setTimeout(() => {
    entry.reconnectGraceTimer = null;
    entry.graceArmedAt = null;
    _memLeave(meetingId, userId);
    if (typeof onExpire === 'function') onExpire();
  }, ms);
  return entry.reconnectGraceTimer;
}

function _memCancelDisconnectGrace(meetingId, userId) {
  const entry = _memGet(meetingId, userId);
  if (!entry?.reconnectGraceTimer) return;
  clearTimeout(entry.reconnectGraceTimer);
  entry.reconnectGraceTimer = null;
  entry.graceArmedAt = null;
}

function _memClearMeeting(meetingId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  const m = _byMeeting.get(mid);
  if (!m) return;
  for (const entry of m.values()) {
    if (entry.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
  }
  _byMeeting.delete(mid);
}

// ── Redis ───────────────────────────────────────────────────────────────────

async function _redisGet(client, meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return null;
  const raw = await client.hGet(keyOf(mid), String(Number(userId)));
  return raw ? JSON.parse(raw) : null;
}

// Rejoue exactement _memTryJoin en une seule opération atomique côté serveur.
// Le désarmement de la grâce (graceArmedAt = null) fait partie du même script :
// un rejoin doit invalider un job de grâce en vol, y compris déjà verrouillé
// par un worker — c'est ce jeton que le handler revalide avant d'agir.
const TRY_JOIN_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local joinedAt = tonumber(ARGV[4])
local resumed = false
if raw then
  local existing = cjson.decode(raw)
  if existing.activeDeviceId and existing.activeDeviceId ~= ARGV[2] then
    return cjson.encode({ok=false, code='ACCOUNT_ALREADY_IN_MEETING'})
  end
  if existing.activeDeviceId == ARGV[2] then resumed = true end
  if existing.joinedAt then joinedAt = existing.joinedAt end
end
local entry = {
  activeDeviceId = ARGV[2],
  activeSocketId = ARGV[3],
  joinedAt = joinedAt,
  graceArmedAt = cjson.null,
}
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
return cjson.encode({ok=true, resumed=resumed})
`;

async function _redisTryJoin(client, mid, uid, did, socketId) {
  const raw = await runScript(
    client,
    TRY_JOIN_SCRIPT,
    [keyOf(mid)],
    [String(uid), did, socketId ?? '', Date.now()],
  );
  return JSON.parse(raw);
}

async function _redisLeave(client, meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  await cancelByDedupeKey(dedupe(mid, userId), [GRACE_KIND]);
  await client.hDel(keyOf(mid), String(Number(userId)));
}

// Pose le jeton graceArmedAt ET la ligne job_queue en un seul geste logique :
// le jeton est ce qui permet au handler de savoir, à l'expiration, si la
// grâce qu'il exécute est toujours celle qui a été armée (un rejoin ou un
// leave entre-temps l'a remis à null, et le handler devient un no-op).
async function _redisArmDisconnectGrace(client, meetingId, userId, ms) {
  const mid = _mid(meetingId);
  if (!mid) return null;
  const entry = await _redisGet(client, mid, userId);
  if (!entry) return null;
  const graceArmedAt = Date.now();
  entry.graceArmedAt = graceArmedAt;
  await client.hSet(keyOf(mid), String(Number(userId)), JSON.stringify(entry));
  await cancelByDedupeKey(dedupe(mid, userId), [GRACE_KIND]);
  await enqueue(
    GRACE_KIND,
    { meetingID: mid, userID: Number(userId), graceArmedAt },
    { dedupeKey: dedupe(mid, userId), runAfter: new Date(Date.now() + ms) },
  );
  return graceArmedAt;
}

async function _redisCancelDisconnectGrace(client, meetingId, userId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  const entry = await _redisGet(client, mid, userId);
  if (entry && entry.graceArmedAt != null) {
    entry.graceArmedAt = null;
    await client.hSet(keyOf(mid), String(Number(userId)), JSON.stringify(entry));
  }
  await cancelByDedupeKey(dedupe(mid, userId), [GRACE_KIND]);
}

async function _redisClearMeeting(client, meetingId) {
  const mid = _mid(meetingId);
  if (!mid) return;
  const all = await client.hGetAll(keyOf(mid));
  for (const uid of Object.keys(all || {})) {
    await cancelByDedupeKey(dedupe(mid, uid), [GRACE_KIND]);
  }
  await client.del(keyOf(mid));
}

// ── API publique (inchangée) ────────────────────────────────────────────────

async function get(meetingId, userId) {
  const client = getDataClient();
  if (client) return _redisGet(client, meetingId, userId);
  return _memGet(meetingId, userId);
}

/**
 * @returns {{ ok: true, resumed?: boolean } | { ok: false, code: string }}
 */
async function tryJoin(meetingId, userId, deviceId, socketId) {
  const mid = _mid(meetingId);
  const uid = Number(userId);
  const did = normalizeDeviceId(deviceId);
  if (!mid || !uid) return { ok: false, code: 'INVALID' };
  if (!did) return { ok: false, code: 'DEVICE_ID_REQUIRED' };

  const client = getDataClient();
  if (client) {
    await cancelByDedupeKey(dedupe(mid, uid), [GRACE_KIND]);
    return _redisTryJoin(client, mid, uid, did, socketId);
  }
  return _memTryJoin(mid, uid, did, socketId);
}

async function leave(meetingId, userId) {
  const client = getDataClient();
  if (client) return _redisLeave(client, meetingId, userId);
  return _memLeave(meetingId, userId);
}

/**
 * Arme une grâce avant de libérer la place (disconnect owner).
 *
 * `onExpire` n'est utilisé que par le repli mémoire : côté Redis la cascade
 * est exécutée par le handler job_queue (meetingWorkers.js), qui appelle la
 * MÊME fonction — les deux chemins partagent donc une seule implémentation.
 */
async function armDisconnectGrace(meetingId, userId, onExpire, ms = OWNER_GRACE_MS) {
  const client = getDataClient();
  if (client) return _redisArmDisconnectGrace(client, meetingId, userId, ms);
  return _memArmDisconnectGrace(meetingId, userId, onExpire, ms);
}

async function cancelDisconnectGrace(meetingId, userId) {
  const client = getDataClient();
  if (client) return _redisCancelDisconnectGrace(client, meetingId, userId);
  return _memCancelDisconnectGrace(meetingId, userId);
}

async function isOwnerDevice(meetingId, userId, deviceId) {
  const did = normalizeDeviceId(deviceId);
  if (!did) return false;
  const entry = await get(meetingId, userId);
  return !!(entry && entry.activeDeviceId === did);
}

async function getActiveDeviceId(meetingId, userId) {
  const entry = await get(meetingId, userId);
  return entry?.activeDeviceId ?? null;
}

async function clearMeeting(meetingId) {
  const client = getDataClient();
  if (client) return _redisClearMeeting(client, meetingId);
  return _memClearMeeting(meetingId);
}

/** Réservé aux tests du repli mémoire. */
function _reset() {
  for (const m of _byMeeting.values()) {
    for (const entry of m.values()) {
      if (entry.reconnectGraceTimer) clearTimeout(entry.reconnectGraceTimer);
    }
  }
  _byMeeting.clear();
}

module.exports = {
  OWNER_GRACE_MS,
  get,
  tryJoin,
  leave,
  armDisconnectGrace,
  cancelDisconnectGrace,
  isOwnerDevice,
  getActiveDeviceId,
  clearMeeting,
  _reset,
};
