/**
 * Cache court conversationID → participants (hors expéditeur) pour les accusés
 * et message:send. TTL 60 s — invalidation TTL seule en v1.
 */

const TTL_MS = 60_000;
const _cache = new Map();

function _key(conversationID, exceptUserID) {
  return `${conversationID}:${exceptUserID}`;
}

function getCachedParticipants(conversationID, exceptUserID) {
  const k = _key(conversationID, exceptUserID);
  const entry = _cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    _cache.delete(k);
    return null;
  }
  return entry.participants;
}

function setCachedParticipants(conversationID, exceptUserID, participants) {
  const k = _key(conversationID, exceptUserID);
  _cache.set(k, { at: Date.now(), participants });
  // Garde-fou mémoire : purge opportuniste au-delà de 500 clés.
  if (_cache.size > 500) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function invalidateConversationParticipants(conversationID) {
  const prefix = `${conversationID}:`;
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

module.exports = {
  getCachedParticipants,
  setCachedParticipants,
  invalidateConversationParticipants,
};
