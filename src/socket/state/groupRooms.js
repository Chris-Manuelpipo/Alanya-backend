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

const {
  enqueue, cancelByDedupeKey, isJobWorkerEnabled,
} = require('../../services/jobQueue');

// Grâce à la déconnexion — voir `armGrace` pour le raisonnement complet.
const GRACE_MS = 15 * 1000;                     // aligné sur la grâce des réunions
const GRACE_KIND = 'group_room_disconnect_grace'; // 27 car., la colonne en tient 40
const TTL_SECONDES = 6 * 60 * 60;               // filet, comme la présence en réunion
const TOMBE_SECONDES = 60;                      // pierre tombale d'un salon terminé

const metaKeyOf = (roomId) => `alanya:groupRooms:${roomId}`;
const partKeyOf = (roomId) => `alanya:groupRooms:${roomId}:p`;
const graceKeyOf = (roomId) => `alanya:groupRooms:${roomId}:g`;
const seqKeyOf = (roomId) => `alanya:groupRooms:${roomId}:seq`;
const deadKeyOf = (roomId) => `alanya:groupRooms:${roomId}:dead`;

const dedupe = (roomId, userId) => `grp_${roomId}_${Number(userId)}`;

// L'identifiant de salon vient du client et alimente l'espace de clés Redis
// ainsi que `dedupe_key`, un VARCHAR(128). Rien ne garantissait sa forme.
const ROOM_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

const _rooms = new Map(); // repli mémoire : roomId -> { isVideo, participants: Map, ownerID, graces: Map }
let _seq = 0;             // jetons de grâce du repli mémoire

function _roomVide(isVideo, ownerID) {
  return {
    isVideo: !!isVideo,
    participants: new Map(),
    ownerID: ownerID ?? null,
    graces: new Map(), // uid -> { jeton, timer }
  };
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
    // Un `create_group_call` rejoué sur le même identifiant laissait des jetons
    // orphelins et des lignes de job armées contre des participants qui
    // n'existent plus dans le nouveau salon.
    const graces = await client.hGetAll(graceKeyOf(roomId));
    for (const uid of Object.keys(graces || {})) {
      await cancelByDedupeKey(dedupe(roomId, uid), [GRACE_KIND]);
    }
    await client.del([
      metaKeyOf(roomId), partKeyOf(roomId), graceKeyOf(roomId),
      seqKeyOf(roomId), deadKeyOf(roomId),
    ]);
    await client.hSet(metaKeyOf(roomId), {
      exists: '1',
      isVideo: isVideo ? '1' : '0',
      ownerID: ownerID != null ? String(ownerID) : '',
    });
    await client.expire(metaKeyOf(roomId), TTL_SECONDES);
    if (ownerID != null) {
      await client.hSet(partKeyOf(roomId), String(ownerID), JSON.stringify(ownerInfo ?? null));
      await client.expire(partKeyOf(roomId), TTL_SECONDES);
    }
    return room;
  }
  _viderGraces(_rooms.get(roomId));
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
// KEYS = métadonnées, participants, grâces, pierre tombale
// ARGV = userId, info (JSON), limite vidéo, limite audio, TTL
//
// Le désarmement de la grâce vit DANS ce script : séparer « je reviens » de
// « annule ma grâce » rouvrirait la fenêtre que la grâce est censée fermer.
const JOIN = `
if redis.call('EXISTS', KEYS[4]) == 1 then return cjson.encode({etat='TERMINEE'}) end
if redis.call('HGET', KEYS[1], 'exists') ~= '1' then
  redis.call('HSET', KEYS[1], 'exists', '1', 'isVideo', '0', 'ownerID', '')
end
local isVideo = redis.call('HGET', KEYS[1], 'isVideo')
local limite = tonumber(ARGV[4])
if isVideo == '1' then limite = tonumber(ARGV[3]) end
local deja = redis.call('HEXISTS', KEYS[2], ARGV[1])
if deja == 0 and redis.call('HLEN', KEYS[2]) >= limite then
  return cjson.encode({etat='PLEIN', isVideo=(isVideo == '1')})
end
local reprise = redis.call('HDEL', KEYS[3], ARGV[1]) == 1
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
local ttl = tonumber(ARGV[5])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('EXPIRE', KEYS[3], ttl)
return cjson.encode({etat='OK', isVideo=(isVideo == '1'), reprise=reprise})
`;

// Arme une grâce et rend son jeton. Vide si le salon ou le participant a
// disparu — il n'y a alors rien à retenir.
//
// Le jeton vient d'un INCR, pas de l'horloge : deux grâces armées dans la même
// milliseconde auraient porté le même horodatage, et la seconde aurait consommé
// la première.
// KEYS = métadonnées, participants, grâces, séquence   ARGV = userId, TTL
const ARM = `
if redis.call('HGET', KEYS[1], 'exists') ~= '1' then return '' end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then return '' end
local jeton = tostring(redis.call('INCR', KEYS[4]))
redis.call('HSET', KEYS[3], ARGV[1], jeton)
local ttl = tonumber(ARGV[2])
for i = 1, 4 do redis.call('EXPIRE', KEYS[i], ttl) end
return jeton
`;

// Consomme une grâce et retire le participant — en un seul geste.
//
// C'est ce qui rend inoffensif un job déjà verrouillé par le worker : une fois
// verrouillé, il ne peut plus être annulé, et il faut donc que la vérification
// du jeton et le retrait soient indivisibles. Les vérifier séparément laisserait
// un rejoin se glisser entre les deux et se faire éjecter.
//
// KEYS = métadonnées, participants, grâces
// ARGV = userId, jeton ('' = départ volontaire, inconditionnel)
const EXPIRE_OU_PART = `
if ARGV[2] ~= '' and redis.call('HGET', KEYS[3], ARGV[1]) ~= ARGV[2] then
  return cjson.encode({consomme=false})
end
redis.call('HDEL', KEYS[3], ARGV[1])
local present = redis.call('HDEL', KEYS[2], ARGV[1]) == 1
local etaitOrg = (redis.call('HGET', KEYS[1], 'ownerID') == ARGV[1])
local restants = redis.call('HLEN', KEYS[2])
if restants == 0 then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  return cjson.encode({consomme=true, present=present, restants=0, detruit=true, etaitOrganisateur=etaitOrg})
end
if etaitOrg then redis.call('HSET', KEYS[1], 'ownerID', '') end
return cjson.encode({consomme=true, present=present, restants=restants, detruit=false, etaitOrganisateur=etaitOrg})
`;

/**
 * @returns {{ ok: true, room: object, reprise: boolean }
 *          | { ok: false, code: 'GROUP_CALL_FULL', isVideo: boolean, limite: number }
 *          | { ok: false, code: 'ROOM_ENDED' }}
 *
 * `reprise` dit que l'entrant tenait une place en grâce : il revient d'une
 * coupure, il n'arrive pas.
 */
async function join(roomId, userID, info = null) {
  const uid = Number(userID);
  const client = getDataClient();

  if (client) {
    const res = JSON.parse(String(await runScript(
      client, JOIN,
      [metaKeyOf(roomId), partKeyOf(roomId), graceKeyOf(roomId), deadKeyOf(roomId)],
      [String(uid), JSON.stringify(info ?? null),
        String(maxParticipants(true)), String(maxParticipants(false)),
        String(TTL_SECONDES)],
    )));
    if (res.etat === 'TERMINEE') return { ok: false, code: 'ROOM_ENDED' };
    if (res.etat === 'PLEIN') {
      return {
        ok: false, code: 'GROUP_CALL_FULL',
        isVideo: !!res.isVideo, limite: maxParticipants(!!res.isVideo),
      };
    }
    if (res.reprise) await cancelByDedupeKey(dedupe(roomId, uid), [GRACE_KIND]);
    return { ok: true, room: await get(roomId), reprise: !!res.reprise };
  }

  let room = _rooms.get(roomId);
  if (!room || !(room.participants instanceof Map)) {
    room = _roomVide(false, null);
    _rooms.set(roomId, room);
  }
  if (!(room.graces instanceof Map)) room.graces = new Map();
  const limite = maxParticipants(room.isVideo);
  if (!room.participants.has(uid) && room.participants.size >= limite) {
    return { ok: false, code: 'GROUP_CALL_FULL', isVideo: room.isVideo, limite };
  }
  const enGrace = room.graces.get(uid);
  if (enGrace) {
    clearTimeout(enGrace.timer);
    room.graces.delete(uid);
  }
  room.participants.set(uid, info);
  return { ok: true, room, reprise: !!enGrace };
}

/**
 * Arme une grâce sur la place de [userID] et rend son jeton.
 *
 * La place est TENUE, pas libérée : un salon vidé de son dernier participant
 * disparaît, et le suivant qui rejoint le recrée en audio et sans organisateur
 * — un appel vidéo à quatre redevenait un salon audio à six que plus personne
 * ne pouvait terminer. Tenir la place évite aussi de se voir refuser son propre
 * appel pour cause de salon plein pendant la fenêtre.
 *
 * Rend `null` si le salon ou le participant n'existe pas : il n'y a alors rien
 * à retenir, et l'appelant ne doit pas croire qu'une grâce court.
 */
async function armGrace(roomId, userID, onExpire, ms = GRACE_MS) {
  if (!isValidRoomId(String(roomId ?? ''))) return null;
  if (userID == null) return null;
  const uid = Number(userID);
  const client = getDataClient();

  if (client) {
    const jeton = String(await runScript(
      client, ARM,
      [metaKeyOf(roomId), partKeyOf(roomId), graceKeyOf(roomId), seqKeyOf(roomId)],
      [String(uid), String(TTL_SECONDES)],
    ));
    if (!jeton) return null;
    // Désarmer avant d'armer : `enqueue` fait ON DUPLICATE KEY UPDATE id = id et
    // rendrait `null` en silence, l'ancienne échéance restant la seule qui compte.
    await cancelByDedupeKey(dedupe(roomId, uid), [GRACE_KIND]);
    await enqueue(
      GRACE_KIND,
      { roomID: String(roomId), userID: uid, jeton },
      {
        dedupeKey: dedupe(roomId, uid),
        runAfter: new Date(Date.now() + ms),
        maxAttempts: 1,
      },
    );
    // Sans worker dans CE process, la ligne resterait en base et la place serait
    // gelée jusqu'au TTL. Le doublon est sans danger : `expireGrace` consomme le
    // jeton atomiquement, le second déclencheur obtient `consomme:false`.
    if (!isJobWorkerEnabled()) {
      setTimeout(() => { _echoir(roomId, uid, jeton, onExpire); }, ms).unref();
    }
    return jeton;
  }

  const room = _rooms.get(roomId);
  const participants = getRoomParticipants(room);
  if (!participants || !participants.has(uid)) return null;
  if (!(room.graces instanceof Map)) room.graces = new Map();
  const precedente = room.graces.get(uid);
  if (precedente) clearTimeout(precedente.timer);
  _seq += 1;
  const jeton = String(_seq);
  const timer = setTimeout(() => { _echoir(roomId, uid, jeton, onExpire); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  room.graces.set(uid, { jeton, timer });
  return jeton;
}

/**
 * Échéance d'une grâce hors du chemin worker : consommer PUIS annoncer.
 *
 * L'ordre n'est pas négociable, et l'inverser était un défaut réel : appeler la
 * seule cascade laissait le participant annoncé parti mais toujours dans le
 * salon — le fantôme que le retrait immédiat d'avant la grâce existait
 * justement pour éviter. Le chemin worker fait bien les deux
 * (`handleGroupRoomDisconnectGrace`) ; les deux replis doivent s'aligner.
 *
 * `consomme:false` signifie que quelqu'un est passé avant : on n'annonce rien.
 */
async function _echoir(roomId, userID, jeton, onExpire) {
  try {
    const r = await _retirer(roomId, userID, String(jeton));
    if (!r.consomme) return;
    if (typeof onExpire === 'function') await onExpire();
  } catch (e) {
    console.warn('[groupRooms] échéance de grâce échouée:', e.message);
  }
}

/**
 * Consomme la grâce [jeton] et retire le participant — indivisiblement.
 *
 * `consomme:false` signifie que quelqu'un est passé avant : un rejoin, un départ
 * volontaire, une fin de salon, ou ce même job rejoué.
 */
async function expireGrace(roomId, userID, jeton) {
  return _retirer(roomId, userID, String(jeton ?? ''));
}

/** Désarme sans retirer — le participant s'en va de lui-même. */
async function cancelGrace(roomId, userID) {
  if (roomId == null || userID == null) return;
  const uid = Number(userID);
  const client = getDataClient();
  if (client) {
    await client.hDel(graceKeyOf(roomId), String(uid));
    await cancelByDedupeKey(dedupe(roomId, uid), [GRACE_KIND]);
    return;
  }
  const room = _rooms.get(roomId);
  const g = room?.graces?.get(uid);
  if (g) { clearTimeout(g.timer); room.graces.delete(uid); }
}

/** Jeton de la grâce en cours, ou `null`. */
async function getGrace(roomId, userID) {
  if (roomId == null || userID == null) return null;
  const uid = Number(userID);
  const client = getDataClient();
  if (client) return (await client.hGet(graceKeyOf(roomId), String(uid))) ?? null;
  return _rooms.get(roomId)?.graces?.get(uid)?.jeton ?? null;
}

/**
 * Retire un participant. Le salon disparaît quand il se vide — sans quoi
 * chaque appel terminé laisserait une entrée immortelle, et un participant
 * fantôme finirait par rendre le salon « complet » pour tout le monde.
 *
 * `etaitOrganisateur` : le partant tenait le droit de mettre fin à l'appel. Il
 * est rendu à la salle (`ownerID` vidé), faute de quoi plus personne ne pouvait
 * la terminer — `end_group_call` n'accepte que l'organisateur, ou n'importe quel
 * participant si le salon n'en a plus.
 *
 * @returns {{ restants: number, detruit: boolean, etaitOrganisateur: boolean }}
 */
async function leave(roomId, userID) {
  const r = await _retirer(roomId, userID, '');
  return { restants: r.restants, detruit: r.detruit, etaitOrganisateur: r.etaitOrganisateur };
}

/** Corps commun de `leave` (jeton vide) et `expireGrace` (jeton exigé). */
async function _retirer(roomId, userID, jeton) {
  const vide = {
    consomme: false, present: false, restants: 0, detruit: false, etaitOrganisateur: false,
  };
  if (roomId == null || userID == null) return vide;
  const uid = Number(userID);
  const client = getDataClient();

  if (client) {
    const r = JSON.parse(String(await runScript(
      client, EXPIRE_OU_PART,
      [metaKeyOf(roomId), partKeyOf(roomId), graceKeyOf(roomId)],
      [String(uid), jeton],
    )));
    if (!r.consomme) return vide;
    await cancelByDedupeKey(dedupe(roomId, uid), [GRACE_KIND]);
    return {
      consomme: true,
      present: !!r.present,
      restants: r.restants,
      detruit: !!r.detruit,
      etaitOrganisateur: !!r.etaitOrganisateur,
    };
  }

  const room = _rooms.get(roomId);
  const participants = getRoomParticipants(room);
  if (!participants) return vide;
  if (!(room.graces instanceof Map)) room.graces = new Map();
  const enCours = room.graces.get(uid);
  if (jeton !== '' && enCours?.jeton !== jeton) return vide;
  if (enCours) { clearTimeout(enCours.timer); room.graces.delete(uid); }

  const present = participants.delete(uid);
  const etaitOrganisateur = room.ownerID != null && Number(room.ownerID) === uid;
  if (participants.size === 0) {
    _viderGraces(room);
    _rooms.delete(roomId);
    return { consomme: true, present, restants: 0, detruit: true, etaitOrganisateur };
  }
  if (etaitOrganisateur) room.ownerID = null;
  return {
    consomme: true, present, restants: participants.size, detruit: false, etaitOrganisateur,
  };
}

function _viderGraces(room) {
  if (!(room?.graces instanceof Map)) return;
  for (const g of room.graces.values()) clearTimeout(g.timer);
  room.graces.clear();
}

/**
 * Détruit le salon et pose une pierre tombale d'une minute.
 *
 * Sans elle, un client qui n'a pas encore appris la fin de l'appel rejoint et
 * ressuscite le salon — en audio et sans organisateur, puisque `join` recrée les
 * métadonnées par défaut.
 */
async function destroy(roomId) {
  if (roomId == null) return;
  const client = getDataClient();
  if (client) {
    const graces = await client.hGetAll(graceKeyOf(roomId));
    for (const uid of Object.keys(graces || {})) {
      await cancelByDedupeKey(dedupe(roomId, uid), [GRACE_KIND]);
    }
    await client.set(deadKeyOf(roomId), '1', { EX: TOMBE_SECONDES });
    await client.del([metaKeyOf(roomId), partKeyOf(roomId), graceKeyOf(roomId), seqKeyOf(roomId)]);
    return;
  }
  const room = _rooms.get(roomId);
  _viderGraces(room);
  _rooms.delete(roomId);
}

/** Réservé aux tests du repli mémoire. */
function _reset() {
  for (const room of _rooms.values()) _viderGraces(room);
  _rooms.clear();
  _seq = 0;
}

/** Réservé aux tests : combien de minuteries de grâce restent armées. */
function _pendingGraceCount() {
  let n = 0;
  for (const room of _rooms.values()) n += room.graces instanceof Map ? room.graces.size : 0;
  return n;
}

module.exports = {
  get, create, join, leave, destroy, getRoomParticipants,
  armGrace, expireGrace, cancelGrace, getGrace, isValidRoomId,
  GRACE_KIND, GRACE_MS,
  _reset, _pendingGraceCount,
};
