// Buffer des appels entrants en attente, indexé par destinataire. Permet de
// rejouer l'event `incoming_call` (et son offre WebRTC) quand le destinataire
// se (re)connecte après avoir été réveillé par un push FCM alors que son app
// était fermée — sinon l'offre, émise en temps réel, est perdue.
//
// Deux implémentations : Redis (partagée entre instances pm2) si
// REDIS_URL est configuré, sinon repli sur une Map locale au process
// (comportement mono-instance identique à avant l'intégration Redis).
// Le choix se fait à chaque appel via getDataClient() — jamais figé au
// chargement du module, puisque la connexion Redis se fait après le require.

const { getDataClient } = require('../../config/redisData');

const TTL_MS = 60 * 1000; // sonnerie CallKit = 30 s ; marge incluse.
const REPLAY_GUARD_MS = 8000;

const keyOf = (targetID) => `alanya:pendingCalls:${targetID}`;

// ── Repli mémoire (targetID(number) -> { payload, callId, createdAt, expiresAt, deliveredAt, attempts }) ──
const _pending = new Map();

function _memSet(targetID, payload) {
  const now = Date.now();
  _pending.set(targetID, {
    payload,
    callId: payload?.callId ?? null,
    createdAt: now,
    expiresAt: now + TTL_MS,
    deliveredAt: null,
    attempts: 0,
  });
}

function _memGetEntry(targetID) {
  const entry = _pending.get(targetID);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _pending.delete(targetID);
    return null;
  }
  return entry;
}

function _memMarkDelivered(targetID, source) {
  const entry = _memGetEntry(targetID);
  if (!entry) return null;
  entry.deliveredAt = Date.now();
  entry.attempts += 1;
  return { callId: entry.callId, source, attempts: entry.attempts };
}

function _memMarkUndelivered(targetID) {
  const entry = _memGetEntry(targetID);
  if (!entry) return;
  entry.deliveredAt = null;
  entry.attempts = 0;
}

function _memClear(targetID) {
  _pending.delete(targetID);
}

// ── Redis (entry sans expiresAt : le TTL natif remplace la comparaison manuelle) ──

async function _redisSet(client, targetID, payload) {
  const entry = {
    payload,
    callId: payload?.callId ?? null,
    createdAt: Date.now(),
    deliveredAt: null,
    attempts: 0,
  };
  await client.set(keyOf(targetID), JSON.stringify(entry), { PX: TTL_MS });
}

async function _redisGetEntry(client, targetID) {
  const raw = await client.get(keyOf(targetID));
  return raw ? JSON.parse(raw) : null;
}

// markDelivered/markUndelivered : lecture-modification-écriture avec KEEPTTL
// — sans lui, chaque mise à jour repousserait silencieusement le TTL de 60 s
// (l'original ne touchait jamais expiresAt après la création). Pas de script
// Lua nécessaire : au pire une course rejoue l'appel deux fois ou désynchronise
// légèrement `attempts`, impact fonctionnel mineur (pas de CAS identifié ici).
async function _redisMarkDelivered(client, targetID, source) {
  const entry = await _redisGetEntry(client, targetID);
  if (!entry) return null;
  entry.deliveredAt = Date.now();
  entry.attempts += 1;
  await client.set(keyOf(targetID), JSON.stringify(entry), { KEEPTTL: true });
  return { callId: entry.callId, source, attempts: entry.attempts };
}

async function _redisMarkUndelivered(client, targetID) {
  const entry = await _redisGetEntry(client, targetID);
  if (!entry) return;
  entry.deliveredAt = null;
  entry.attempts = 0;
  await client.set(keyOf(targetID), JSON.stringify(entry), { KEEPTTL: true });
}

async function _redisClear(client, targetID) {
  await client.del(keyOf(targetID));
}

// ── API publique (inchangée) ──────────────────────────────────────────────

async function set(targetID, payload) {
  if (targetID == null) return;
  const client = getDataClient();
  if (client) return _redisSet(client, targetID, payload);
  return _memSet(targetID, payload);
}

async function _getEntry(targetID) {
  const client = getDataClient();
  if (client) return _redisGetEntry(client, targetID);
  return _memGetEntry(targetID);
}

async function get(targetID) {
  const entry = await _getEntry(targetID);
  return entry ? entry.payload : null;
}

async function getReplayable(targetID) {
  const entry = await _getEntry(targetID);
  if (!entry) return null;
  if (entry.deliveredAt) return null;
  if (entry.attempts > 0 && Date.now() - entry.createdAt > REPLAY_GUARD_MS) return null;
  return entry.payload;
}

async function markDelivered(targetID, source = 'socket') {
  const client = getDataClient();
  if (client) return _redisMarkDelivered(client, targetID, source);
  return _memMarkDelivered(targetID, source);
}

async function clear(targetID) {
  if (targetID == null) return;
  const client = getDataClient();
  if (client) return _redisClear(client, targetID);
  return _memClear(targetID);
}

// Réinitialise la livraison quand le socket se déconnecte (app tuée en arrière-plan
// après réception live de l'offre) pour permettre le rejeu à la reconnexion.
async function markUndelivered(targetID) {
  const client = getDataClient();
  if (client) return _redisMarkUndelivered(client, targetID);
  return _memMarkUndelivered(targetID);
}

module.exports = { set, get, getReplayable, markDelivered, clear, markUndelivered };
