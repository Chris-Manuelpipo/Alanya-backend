// Tampon des candidats ICE émis pendant que le téléphone du destinataire sonne.
//
// L'appelant rassemble ses candidats dès qu'il a créé son offre — une à deux
// secondes après le début de l'appel, donc bien avant qu'on décroche. Or le
// relais `ice_candidate` exige un appareil actif côté destinataire, et celui-ci
// n'en a pas tant qu'il sonne : `ring()` pose l'entrée sans activeDeviceId, et
// seul `tryClaim()` au décrochage lui en donne un. Chacun de ces candidats
// était donc jeté, et l'appelant n'en réémet jamais : `onIceCandidate` ne passe
// qu'une fois par candidat.
//
// Le destinataire se retrouvait sans un seul candidat distant — incapable de
// former la moindre paire, et son allocation TURN sans aucune permission, donc
// sourde aux tests de connectivité de l'appelant. L'appel restait muet jusqu'à
// ce que la PeerConnection de l'appelant renonce et relance un ICE restart,
// dont le SDP embarque cette fois les candidats déjà rassemblés. D'où une
// vingtaine de secondes de silence avant que le média ne passe.
//
// On garde donc ces candidats le temps de la sonnerie et on les rejoue au
// décrochage. Deux implémentations comme les autres modules d'état : Redis si
// REDIS_URL est configuré, sinon repli sur une Map locale au process.

const { getDataClient } = require('../../config/redisData');

// Aligné sur pendingCalls : sonnerie CallKit de 30 s, marge incluse. Passé ce
// délai, l'appel n'a pas été décroché et les candidats n'ont plus d'intérêt —
// c'est aussi ce qui nettoie le tampon d'un appel refusé ou sans réponse.
const TTL_MS = 60 * 1000;

// Un appel vidéo en rassemble quelques dizaines (host, srflx, relay × ufrag).
// Le plafond protège d'un client qui en émettrait sans fin.
const MAX_CANDIDATES = 256;

const keyOf = (callKey, userId) =>
  `alanya:pendingIce:${callKey}:${Number(userId)}`;

// ── Repli mémoire (key -> { items: [], expiresAt }) ──────────────────────────
const _buffers = new Map();

function _memEntry(key) {
  const entry = _buffers.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _buffers.delete(key);
    return null;
  }
  return entry;
}

function _memPush(key, payload) {
  let entry = _memEntry(key);
  if (!entry) {
    entry = { items: [], expiresAt: Date.now() + TTL_MS };
    _buffers.set(key, entry);
  }
  if (entry.items.length >= MAX_CANDIDATES) return false;
  entry.items.push(payload);
  return true;
}

function _memDrain(key) {
  const entry = _memEntry(key);
  _buffers.delete(key);
  return entry ? entry.items : [];
}

// ── Redis (liste + TTL natif) ────────────────────────────────────────────────

async function _redisPush(client, key, payload) {
  const len = await client.lLen(key);
  if (len >= MAX_CANDIDATES) return false;
  await client.rPush(key, JSON.stringify(payload));
  await client.pExpire(key, TTL_MS);
  return true;
}

async function _redisDrain(client, key) {
  const raw = await client.lRange(key, 0, -1);
  if (raw.length) await client.del(key);
  return raw.map((r) => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Garde un candidat pour [userId] le temps qu'il décroche. false = plafond atteint. */
async function push(callKey, userId, payload) {
  const key = keyOf(callKey, userId);
  const client = getDataClient();
  if (client) return _redisPush(client, key, payload);
  return _memPush(key, payload);
}

/** Rend les candidats gardés pour [userId] et vide le tampon. */
async function drain(callKey, userId) {
  const key = keyOf(callKey, userId);
  const client = getDataClient();
  if (client) return _redisDrain(client, key);
  return _memDrain(key);
}

/** Solde le tampon sans le lire (appel refusé, annulé, sans réponse). */
async function clear(callKey, userId) {
  const key = keyOf(callKey, userId);
  const client = getDataClient();
  if (client) {
    await client.del(key);
    return;
  }
  _buffers.delete(key);
}

module.exports = { push, drain, clear, MAX_CANDIDATES, TTL_MS };
