// Sessions éphémères de connexion par QR : un appareil non connecté affiche un
// QR, un appareil déjà connecté le scanne et approuve, l'appareil demandeur
// récupère ses tokens.
//
// Deux secrets distincts par session, ne jamais les confondre :
//   - scanSecret : DANS le QR, prouve qu'on l'a vu (appareil qui SCANNE) ;
//   - pollToken  : JAMAIS dans le QR, remis uniquement à l'appareil qui a CRÉÉ
//     la session (interrogation du statut et récupération des tokens).
// Sans cette séparation, quiconque photographie le QR pourrait interroger la
// session et voler les tokens une fois l'utilisateur ayant approuvé.
//
// Deux implémentations : Redis si REDIS_URL est configuré (sessions partagées
// entre instances), sinon repli sur une Map locale au process.
//
// Côté Redis, la session est un HASH avec un champ par attribut, et non un
// seul JSON. Les scripts Lua ne manipulent alors que `status`, un scalaire :
// `result` — qui porte les tokens et des valeurs nulles — ne transite jamais
// par le cycle décodage/réencodage JSON de Lua, où `null` et objets vides se
// déforment silencieusement.
//
// Les transitions de statut sont des CAS : l'approbation demande plusieurs
// allers-retours en base, pendant lesquels une seconde confirmation ne doit
// pas pouvoir passer. En mémoire, le mono-thread JS suffisait ; réparti sur
// plusieurs instances, il faut une opération atomique côté serveur Redis.

const { generateOpaqueToken } = require('../../utils/qrToken');
const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');

const TTL_MS = 90 * 1000; // durée d'affichage du QR côté appareil demandeur

const keyOf = (sessionId) => `alanya:qrLoginSessions:${sessionId}`;

/** Statuts depuis lesquels une session peut encore être tranchée. */
const OUVERTS = ['pending', 'scanned'];

// ── Repli mémoire ───────────────────────────────────────────────────────────

const _sessions = new Map();

// Plafond de sécurité : la route de création n'est pas authentifiée et son
// authLimiter a skipSuccessfulRequests, donc les créations réussies ne
// consomment aucun quota. Sans borne, un client qui crée sans jamais interroger
// laisserait croître la Map indéfiniment. On balaie un échantillon à chaque
// création, et on évince en FIFO si le plafond est atteint.
// Côté Redis, le TTL natif joue ce rôle : rien ne survit à 90 s.
const MAX_SESSIONS = 10000;
const SWEEP_PER_CREATE = 20;

function _sweep() {
  const now = Date.now();
  let vus = 0;
  for (const [id, entry] of _sessions) {
    if (vus++ >= SWEEP_PER_CREATE) break;
    if (now > entry.expiresAt) _sessions.delete(id);
  }
  while (_sessions.size >= MAX_SESSIONS) {
    const plusAncienne = _sessions.keys().next();
    if (plusAncienne.done) break;
    _sessions.delete(plusAncienne.value);
  }
}

// Expiration paresseuse : pas de setInterval, une session périmée disparaît à
// la première lecture qui la rencontre.
function _memGet(sessionId) {
  if (sessionId == null) return null;
  const entry = _sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _sessions.delete(sessionId);
    return null;
  }
  return entry;
}

// ── Redis ───────────────────────────────────────────────────────────────────

/** Reconstruit l'objet de session depuis le HASH (tout arrive en chaîne). */
function _depuisHash(h) {
  if (!h || !h.sessionId) return null;
  const nombreOuNull = (v) => (v == null || v === '' ? null : Number(v));
  const jsonOuNull = (v) => {
    if (v == null || v === '') return null;
    try { return JSON.parse(v); } catch { return null; }
  };
  return {
    sessionId: h.sessionId,
    scanSecret: h.scanSecret,
    pollToken: h.pollToken,
    status: h.status,
    deviceId: h.deviceId || null,
    deviceName: h.deviceName || null,
    platform: h.platform || null,
    ipAddress: h.ipAddress || null,
    location: jsonOuNull(h.location),
    createdAt: Number(h.createdAt),
    expiresAt: Number(h.expiresAt),
    scannedByAlanyaID: nombreOuNull(h.scannedByAlanyaID),
    result: jsonOuNull(h.result),
    previousStatus: h.previousStatus || null,
  };
}

async function _redisGet(client, sessionId) {
  if (sessionId == null) return null;
  const h = await client.hGetAll(keyOf(sessionId));
  return _depuisHash(h);
}

/**
 * Transition de statut atomique.
 *
 * ARGV[1] = statuts de départ acceptés, séparés par des virgules
 * ARGV[2] = statut d'arrivée
 * ARGV[3..] = paires champ/valeur à écrire en même temps
 *
 * Retourne le statut de départ si la transition a eu lieu, une chaîne vide si
 * la session n'existe pas, et 'REFUS:<statut>' si le statut courant n'était
 * pas acceptable. Distinguer les deux permet à l'appelant de répondre
 * « expirée » ou « déjà traitée » sans se tromper.
 */
const TRANSITION = `
local courant = redis.call('HGET', KEYS[1], 'status')
if not courant then return '' end
local ok = false
for depart in string.gmatch(ARGV[1], '[^,]+') do
  if depart == courant then ok = true end
end
if not ok then return 'REFUS:' .. courant end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
for i = 3, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
return courant
`;

async function _transition(client, sessionId, departs, arrivee, champs = {}) {
  const args = [departs.join(','), arrivee];
  for (const [k, v] of Object.entries(champs)) args.push(k, v);
  const res = await runScript(client, TRANSITION, [keyOf(sessionId)], args);
  if (res === '' || res == null) return { ok: false, absente: true };
  if (String(res).startsWith('REFUS:')) {
    return { ok: false, absente: false, statut: String(res).slice(6) };
  }
  return { ok: true, depart: String(res) };
}

// ── API publique ────────────────────────────────────────────────────────────

async function create({ deviceId, deviceName, platform, ipAddress } = {}) {
  const now = Date.now();
  const entry = {
    sessionId: generateOpaqueToken(16),
    scanSecret: generateOpaqueToken(16),
    pollToken: generateOpaqueToken(32),
    status: 'pending',
    deviceId: deviceId ?? null,
    deviceName: deviceName ?? null,
    platform: platform ?? null,
    ipAddress: ipAddress ?? null,
    // Lieu approximatif déduit de l'IP, renseigné en arrière-plan après la
    // création (voir services/ipGeoService). Reste null si le fournisseur n'a
    // pas répondu à temps : l'écran retombe alors sur l'adresse brute.
    location: null,
    createdAt: now,
    expiresAt: now + TTL_MS,
    scannedByAlanyaID: null,
    result: null,
  };

  const client = getDataClient();
  if (client) {
    // Les champs absents ne sont pas écrits : un HASH ne stocke pas `null`, et
    // `_depuisHash` retraduit l'absence en null.
    const plat = {
      sessionId: entry.sessionId,
      scanSecret: entry.scanSecret,
      pollToken: entry.pollToken,
      status: entry.status,
      createdAt: String(entry.createdAt),
      expiresAt: String(entry.expiresAt),
    };
    for (const champ of ['deviceId', 'deviceName', 'platform', 'ipAddress']) {
      if (entry[champ] != null) plat[champ] = String(entry[champ]);
    }
    await client.hSet(keyOf(entry.sessionId), plat);
    await client.pExpire(keyOf(entry.sessionId), TTL_MS);
    return entry;
  }

  _sweep();
  _sessions.set(entry.sessionId, entry);
  return entry;
}

async function get(sessionId) {
  const client = getDataClient();
  if (client) return _redisGet(client, sessionId);
  return _memGet(sessionId);
}

/**
 * Renseigne le lieu déduit de l'IP, après coup.
 *
 * Existe parce qu'un appelant mutait auparavant l'objet rendu par `get()`
 * (`vivante.location = lieu`), ce qui ne fonctionnait que tant que `Map.get()`
 * rendait une référence vivante. Sur Redis, `get()` rend une copie : la
 * mutation ne persistait plus rien, sans la moindre erreur.
 */
async function setLocation(sessionId, location) {
  if (sessionId == null || location == null) return false;
  const client = getDataClient();
  if (client) {
    // `HSET` sur une clé disparue la ressusciterait sans TTL : ne rien écrire
    // si la session a expiré entre-temps.
    const existe = await client.exists(keyOf(sessionId));
    if (!existe) return false;
    await client.hSet(keyOf(sessionId), 'location', JSON.stringify(location));
    return true;
  }
  const entry = _memGet(sessionId);
  if (!entry) return false;
  entry.location = location;
  return true;
}

/**
 * Marque la session comme scannée. Purement informatif : rescanner un QR déjà
 * scanné ne doit rien casser, et un scan ne peut jamais faire régresser une
 * session déjà tranchée.
 */
async function markScanned(sessionId, scannedByAlanyaID) {
  const client = getDataClient();
  if (client) {
    const champs = scannedByAlanyaID != null
      ? { scannedByAlanyaID: String(scannedByAlanyaID) }
      : {};
    await _transition(client, sessionId, OUVERTS, 'scanned', champs);
    return _redisGet(client, sessionId);
  }
  const entry = _memGet(sessionId);
  if (!entry) return null;
  if (!OUVERTS.includes(entry.status)) return entry;
  entry.status = 'scanned';
  if (scannedByAlanyaID != null) entry.scannedByAlanyaID = scannedByAlanyaID;
  return entry;
}

/**
 * Réserve la session pour une approbation en cours.
 *
 * L'approbation demande plusieurs `await` (lecture du compte, écriture dans
 * `appareils`, génération des tokens). Sans réservation, deux confirmations
 * quasi simultanées franchissent toutes deux la garde de statut et la seconde
 * écrase le résultat de la première : l'appareil demandeur ouvrirait le compte
 * du second.
 *
 * @returns {object|null} l'entrée réservée, ou null si elle est déjà expirée,
 *   traitée ou en cours d'approbation.
 */
async function beginApproval(sessionId) {
  const client = getDataClient();
  if (client) {
    const r = await _transition(client, sessionId, OUVERTS, 'approving');
    if (!r.ok) return null;
    await client.hSet(keyOf(sessionId), 'previousStatus', r.depart);
    return _redisGet(client, sessionId);
  }
  const entry = _memGet(sessionId);
  if (!entry || !OUVERTS.includes(entry.status)) return null;
  entry.previousStatus = entry.status;
  entry.status = 'approving';
  return entry;
}

/** Rend la session à son statut d'avant [beginApproval] si l'approbation échoue. */
async function abortApproval(sessionId) {
  const client = getDataClient();
  if (client) {
    const h = await client.hGetAll(keyOf(sessionId));
    if (!h || h.status !== 'approving') return null;
    const r = await _transition(client, sessionId, ['approving'], h.previousStatus || 'pending');
    if (!r.ok) return null;
    return _redisGet(client, sessionId);
  }
  const entry = _memGet(sessionId);
  if (!entry || entry.status !== 'approving') return null;
  entry.status = entry.previousStatus ?? 'pending';
  return entry;
}

/**
 * Solde l'approbation. La session a pu expirer pendant les `await` : l'appelant
 * DOIT tester ce retour, sinon il annonce une approbation dont personne ne
 * verra les tokens.
 */
async function approve(sessionId, { scannedByAlanyaID, result } = {}) {
  const client = getDataClient();
  if (client) {
    const champs = { result: JSON.stringify(result ?? null) };
    if (scannedByAlanyaID != null) champs.scannedByAlanyaID = String(scannedByAlanyaID);
    const r = await _transition(client, sessionId, ['approving'], 'approved', champs);
    if (!r.ok) return null;
    return _redisGet(client, sessionId);
  }
  const entry = _memGet(sessionId);
  if (!entry || entry.status !== 'approving') return null;
  entry.status = 'approved';
  if (scannedByAlanyaID != null) entry.scannedByAlanyaID = scannedByAlanyaID;
  entry.result = result ?? null;
  return entry;
}

/**
 * Refuse la session.
 *
 * La garde de statut est ici et non chez l'appelant. Elle y était auparavant,
 * en deux appels séparés (lecture du statut, puis `deny`) : sûr tant qu'aucun
 * `await` ne les séparait et qu'un seul process existait. Réparti, un refus en
 * vol pouvait écraser une approbation concurrente et effacer des tokens déjà
 * générés — le demandeur voyait « refusé » alors qu'une session venait de
 * s'ouvrir pour lui.
 *
 * L'entrée est conservée jusqu'au TTL : l'appareil demandeur doit pouvoir lire
 * « refusé » à son prochain poll. La supprimer lui afficherait « expiré »,
 * message trompeur.
 */
async function deny(sessionId) {
  const client = getDataClient();
  if (client) {
    const r = await _transition(client, sessionId, OUVERTS, 'denied', { result: '' });
    if (!r.ok) return null;
    return _redisGet(client, sessionId);
  }
  const entry = _memGet(sessionId);
  if (!entry || !OUVERTS.includes(entry.status)) return null;
  entry.status = 'denied';
  entry.result = null;
  return entry;
}

/**
 * Livraison à usage unique des tokens : lit ET supprime, en une seule
 * opération atomique.
 *
 * Remplace un `get()` suivi d'un `clear()` : deux interrogations concurrentes
 * (retransmission réseau, double appel du client) lisaient toutes deux
 * « approuvée » avant que l'une n'efface, et les tokens partaient deux fois.
 *
 * @returns {object|null} la session si CET appel a emporté la livraison.
 */
async function takeApproved(sessionId) {
  const client = getDataClient();
  if (client) {
    const r = await _transition(client, sessionId, ['approved'], 'delivering');
    if (!r.ok) return null;
    const entry = await _redisGet(client, sessionId);
    await client.del(keyOf(sessionId));
    return entry ? { ...entry, status: 'approved' } : null;
  }
  const entry = _memGet(sessionId);
  if (!entry || entry.status !== 'approved') return null;
  _sessions.delete(sessionId);
  return entry;
}

async function clear(sessionId) {
  if (sessionId == null) return;
  const client = getDataClient();
  if (client) { await client.del(keyOf(sessionId)); return; }
  _sessions.delete(sessionId);
}

/** Réservé aux tests du repli mémoire. */
function _reset() {
  _sessions.clear();
}

module.exports = {
  TTL_MS,
  create,
  get,
  setLocation,
  markScanned,
  beginApproval,
  abortApproval,
  approve,
  deny,
  takeApproved,
  clear,
  _reset,
};
