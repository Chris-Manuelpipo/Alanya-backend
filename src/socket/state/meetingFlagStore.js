/**
 * Fabrique des états booléens par réunion : meetingId → { userId: bool }.
 *
 * `meetingMuteStates` et `meetingVideoStates` étaient deux fichiers
 * rigoureusement identiques au nom des variables près ; les migrer séparément
 * aurait dupliqué deux fois la même implémentation Redis. Ils partagent
 * désormais cette fabrique, chacun avec son propre espace de clés.
 *
 * Deux implémentations : Redis (HASH par réunion, field=userId — partagé
 * entre instances pm2) si REDIS_URL est configuré, sinon repli sur une Map
 * locale au process (comportement mono-instance identique à avant).
 *
 * Pas de CAS ici : un champ n'est jamais écrit que par le socket de
 * l'utilisateur concerné (`socket.alanyaID`, jamais un id venu du client),
 * donc aucune contention entre acteurs différents à arbitrer.
 */

const { getDataClient } = require('../../config/redisData');

function createMeetingFlagStore(namespace) {
  const keyOf = (mID) => `alanya:${namespace}:${String(mID)}`;

  // ── Repli mémoire (meetingKey(string) -> Map<userId(string), bool>) ──────
  const _states = new Map();
  const meetingKey = (mID) => String(mID);

  function _memGetSnapshot(mID, excludeUserId) {
    const states = _states.get(meetingKey(mID));
    if (!states) return {};
    const result = {};
    for (const [userId, flag] of states.entries()) {
      if (excludeUserId != null && userId === String(excludeUserId)) continue;
      result[userId] = flag;
    }
    return result;
  }

  function _memSet(mID, userId, flag) {
    const key = meetingKey(mID);
    if (!_states.has(key)) _states.set(key, new Map());
    _states.get(key).set(String(userId), !!flag);
  }

  function _memRemoveUser(mID, userId) {
    const key = meetingKey(mID);
    const states = _states.get(key);
    if (!states) return;
    states.delete(String(userId));
    if (states.size === 0) _states.delete(key);
  }

  function _memClearMeeting(mID) {
    _states.delete(meetingKey(mID));
  }

  // ── Redis ('1'/'0' plutôt que JSON : un booléen n'a pas besoin de plus) ──

  async function _redisGetSnapshot(client, mID, excludeUserId) {
    const raw = await client.hGetAll(keyOf(mID));
    const result = {};
    for (const [userId, flag] of Object.entries(raw || {})) {
      if (excludeUserId != null && userId === String(excludeUserId)) continue;
      result[userId] = flag === '1';
    }
    return result;
  }

  async function _redisSet(client, mID, userId, flag) {
    await client.hSet(keyOf(mID), String(userId), flag ? '1' : '0');
  }

  async function _redisRemoveUser(client, mID, userId) {
    await client.hDel(keyOf(mID), String(userId));
    // Le HASH disparaît tout seul quand son dernier field part (sémantique
    // Redis) — équivalent du `_states.delete(key)` du repli mémoire.
  }

  async function _redisClearMeeting(client, mID) {
    await client.del(keyOf(mID));
  }

  // ── API publique (inchangée) ────────────────────────────────────────────

  async function getSnapshot(mID, excludeUserId = null) {
    const client = getDataClient();
    if (client) return _redisGetSnapshot(client, mID, excludeUserId);
    return _memGetSnapshot(mID, excludeUserId);
  }

  async function set(mID, userId, flag) {
    const client = getDataClient();
    if (client) return _redisSet(client, mID, userId, flag);
    return _memSet(mID, userId, flag);
  }

  async function removeUser(mID, userId) {
    const client = getDataClient();
    if (client) return _redisRemoveUser(client, mID, userId);
    return _memRemoveUser(mID, userId);
  }

  async function clearMeeting(mID) {
    const client = getDataClient();
    if (client) return _redisClearMeeting(client, mID);
    return _memClearMeeting(mID);
  }

  /** Réservé aux tests du repli mémoire. */
  function _reset() {
    _states.clear();
  }

  return { getSnapshot, set, removeUser, clearMeeting, _reset };
}

module.exports = { createMeetingFlagStore };
