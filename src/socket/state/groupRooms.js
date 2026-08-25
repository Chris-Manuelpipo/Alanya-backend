// Salons d'appel de groupe : qui participe, en audio ou en vidéo, et qui a le
// droit d'y mettre fin pour tout le monde.
//
// Extrait de handlers/calls.js, où il vivait en `Map` non exportée — donc
// intestable, et surtout invisible d'une autre instance. Ce store était le
// seul à être DÉJÀ incorrect en multi-instance : depuis la phase 1, le départ
// de la room Socket.IO est propagé à toutes les instances
// (`io.in(room).socketsLeave(room)`), mais la liste applicative des
// participants, elle, restait locale. Deux participants sur deux instances
// voyaient donc deux listes différentes, et chacun comptait les places
// restantes pour lui seul.
//
// Deux implémentations : Redis si REDIS_URL est configuré, sinon repli sur une
// Map locale au process.
//
// Côté Redis, un salon tient en deux clés : les métadonnées (mode vidéo,
// organisateur) et les participants. Séparer les deux permet de compter les
// participants par un simple `HLEN` — sans avoir à distinguer, dans un même
// hash, ce qui est un participant de ce qui n'en est pas.

const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');
const { maxParticipants } = require('../../constants/participantLimits');

const metaKeyOf = (roomId) => `alanya:groupRooms:${roomId}`;
const partKeyOf = (roomId) => `alanya:groupRooms:${roomId}:p`;

const _rooms = new Map(); // repli mémoire : roomId -> { isVideo, participants: Map, ownerID }

function _roomVide(isVideo, ownerID) {
  return { isVideo: !!isVideo, participants: new Map(), ownerID: ownerID ?? null };
}

function _depuis(meta, participants) {
  if (!meta || meta.exists !== '1') return null;
  const map = new Map();
  for (const [uid, brut] of Object.entries(participants || {})) {
    let info = null;
    try { info = JSON.parse(brut); } catch { info = null; }
    map.set(Number(uid), info);
  }
  return {
    isVideo: meta.isVideo === '1',
    ownerID: meta.ownerID === '' || meta.ownerID == null ? null : Number(meta.ownerID),
    participants: map,
  };
}

/** Participants d'un salon déjà lu. Tolère les formes anciennes. */
function getRoomParticipants(room) {
  if (!room) return null;
  return room.participants ?? room;
}

async function get(roomId) {
  if (roomId == null) return null;
  const client = getDataClient();
  if (client) {
    const [meta, parts] = await Promise.all([
      client.hGetAll(metaKeyOf(roomId)),
      client.hGetAll(partKeyOf(roomId)),
    ]);
    return _depuis(meta, parts);
  }
  return _rooms.get(roomId) ?? null;
}

/** Ouvre un salon et y installe son organisateur. Écrase un salon de même id. */
async function create(roomId, { isVideo = false, ownerID = null, ownerInfo = null } = {}) {
  const room = _roomVide(isVideo, ownerID);
  if (ownerID != null) room.participants.set(ownerID, ownerInfo);

  const client = getDataClient();
  if (client) {
    await client.del([metaKeyOf(roomId), partKeyOf(roomId)]);
    await client.hSet(metaKeyOf(roomId), {
      exists: '1',
      isVideo: isVideo ? '1' : '0',
      ownerID: ownerID != null ? String(ownerID) : '',
    });
    if (ownerID != null) {
      await client.hSet(partKeyOf(roomId), String(ownerID), JSON.stringify(ownerInfo ?? null));
    }
    return room;
  }
  _rooms.set(roomId, room);
  return room;
}

/**
 * Entrée dans un salon, avec contrôle de capacité — en une seule opération.
 *
 * Le contrôle et l'ajout ne peuvent pas être séparés : si N personnes
 * rejoignent en même temps alors qu'il reste une place, chacune lit « il reste
 * de la place » avant qu'aucune n'ait écrit, et le salon déborde sa limite.
 * En mémoire, le mono-thread JS rendait la séquence indivisible ; réparti, il
 * faut le dire explicitement.
 *
 * Crée le salon s'il n'existe pas — un participant peut arriver avant que la
 * création n'ait été enregistrée (ordre des événements réseau). Le salon naît
 * alors sans organisateur, et n'importe lequel de ses membres pourra y mettre
 * fin, faute de mieux.
 *
 * KEYS[1] = métadonnées, KEYS[2] = participants
 * ARGV = userId, info (JSON), limite vidéo, limite audio
 */
const JOIN = `
if redis.call('HGET', KEYS[1], 'exists') ~= '1' then
  redis.call('HSET', KEYS[1], 'exists', '1', 'isVideo', '0', 'ownerID', '')
end
local isVideo = redis.call('HGET', KEYS[1], 'isVideo')
local limite = tonumber(ARGV[4])
if isVideo == '1' then limite = tonumber(ARGV[3]) end
local deja = redis.call('HEXISTS', KEYS[2], ARGV[1])
if deja == 0 and redis.call('HLEN', KEYS[2]) >= limite then
  return 'PLEIN:' .. isVideo
end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return 'OK:' .. isVideo
`;

/**
 * @returns {{ ok: true, room: object } | { ok: false, code: 'GROUP_CALL_FULL', isVideo: boolean, limite: number }}
 */
async function join(roomId, userID, info = null) {
  const uid = Number(userID);
  const client = getDataClient();

  if (client) {
    const res = String(await runScript(
      client, JOIN, [metaKeyOf(roomId), partKeyOf(roomId)],
      [String(uid), JSON.stringify(info ?? null),
        String(maxParticipants(true)), String(maxParticipants(false))],
    ));
    const isVideo = res.endsWith(':1');
    if (res.startsWith('PLEIN')) {
      return { ok: false, code: 'GROUP_CALL_FULL', isVideo, limite: maxParticipants(isVideo) };
    }
    return { ok: true, room: await get(roomId) };
  }

  let room = _rooms.get(roomId);
  if (!room || !(room.participants instanceof Map)) {
    room = _roomVide(false, null);
    _rooms.set(roomId, room);
  }
  const limite = maxParticipants(room.isVideo);
  if (!room.participants.has(uid) && room.participants.size >= limite) {
    return { ok: false, code: 'GROUP_CALL_FULL', isVideo: room.isVideo, limite };
  }
  room.participants.set(uid, info);
  return { ok: true, room };
}

/**
 * Retire un participant. Le salon disparaît quand il se vide — sans quoi
 * chaque appel terminé laisserait une entrée immortelle, et un participant
 * fantôme finirait par rendre le salon « complet » pour tout le monde.
 *
 * @returns {{ restants: number, detruit: boolean }}
 */
async function leave(roomId, userID) {
  if (roomId == null || userID == null) return { restants: 0, detruit: false };
  const uid = Number(userID);
  const client = getDataClient();

  if (client) {
    await client.hDel(partKeyOf(roomId), String(uid));
    const restants = await client.hLen(partKeyOf(roomId));
    if (restants === 0) {
      await client.del([metaKeyOf(roomId), partKeyOf(roomId)]);
      return { restants: 0, detruit: true };
    }
    return { restants, detruit: false };
  }

  const room = _rooms.get(roomId);
  const participants = getRoomParticipants(room);
  if (!participants) return { restants: 0, detruit: false };
  participants.delete(uid);
  if (participants.size === 0) {
    _rooms.delete(roomId);
    return { restants: 0, detruit: true };
  }
  return { restants: participants.size, detruit: false };
}

async function destroy(roomId) {
  if (roomId == null) return;
  const client = getDataClient();
  if (client) { await client.del([metaKeyOf(roomId), partKeyOf(roomId)]); return; }
  _rooms.delete(roomId);
}

/** Réservé aux tests du repli mémoire. */
function _reset() {
  _rooms.clear();
}

module.exports = { get, create, join, leave, destroy, getRoomParticipants, _reset };
