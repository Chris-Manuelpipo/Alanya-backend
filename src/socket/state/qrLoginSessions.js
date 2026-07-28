// Sessions éphémères de connexion par QR : un appareil non connecté affiche un
// QR, un appareil déjà connecté le scanne et approuve, l'appareil demandeur
// récupère ses tokens.
//
// Un état en mémoire suffit, comme pour pendingCalls.js : le déploiement est
// mono-processus (pm2 sans mode cluster), donc tous les sockets et toutes les
// requêtes HTTP voient la même Map. Et une session ne vit que 90 s — la perdre
// à un redémarrage ne coûte qu'un nouveau scan.
//
// Deux secrets distincts par session, ne jamais les confondre :
//   - scanSecret : DANS le QR, prouve qu'on l'a vu (appareil qui SCANNE) ;
//   - pollToken  : JAMAIS dans le QR, remis uniquement à l'appareil qui a CRÉÉ
//     la session (interrogation du statut et récupération des tokens).
// Sans cette séparation, quiconque photographie le QR pourrait interroger la
// session et voler les tokens une fois l'utilisateur ayant approuvé.

const { generateOpaqueToken } = require('../../utils/qrToken');

const TTL_MS = 90 * 1000; // durée d'affichage du QR côté appareil demandeur

// sessionId -> { sessionId, scanSecret, pollToken, status, deviceId, deviceName,
//                platform, ipAddress, createdAt, expiresAt, scannedByAlanyaID, result }
const _sessions = new Map();

// Plafond de sécurité : la route de création n'est pas authentifiée et son
// authLimiter a skipSuccessfulRequests, donc les créations réussies ne
// consomment aucun quota. Sans borne, un client qui crée sans jamais interroger
// laisserait croître la Map indéfiniment dans le process qui héberge aussi tous
// les sockets. On balaie un échantillon à chaque création, et on évince en FIFO
// si le plafond est atteint (Map itère dans l'ordre d'insertion).
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

function create({ deviceId, deviceName, platform, ipAddress } = {}) {
  _sweep();
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
  _sessions.set(entry.sessionId, entry);
  return entry;
}

// Expiration paresseuse : pas de setInterval, une session périmée disparaît à
// la première lecture qui la rencontre.
function _getEntry(sessionId) {
  if (sessionId == null) return null;
  const entry = _sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _sessions.delete(sessionId);
    return null;
  }
  return entry;
}

function get(sessionId) {
  return _getEntry(sessionId);
}

function markScanned(sessionId, scannedByAlanyaID) {
  const entry = _getEntry(sessionId);
  if (!entry) return null;
  // Purement informatif : rescanner un QR déjà scanné ne doit rien casser, et
  // un scan ne peut jamais faire régresser une session déjà tranchée.
  if (entry.status !== 'pending' && entry.status !== 'scanned') return entry;
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
 * du second. Ici, rien n'est asynchrone entre la lecture et l'écriture du
 * statut : en JS mono-thread, la transition est donc atomique.
 *
 * @returns {object|null} l'entrée réservée, ou null si elle est déjà expirée,
 *   traitée ou en cours d'approbation.
 */
function beginApproval(sessionId) {
  const entry = _getEntry(sessionId);
  if (!entry) return null;
  if (entry.status !== 'pending' && entry.status !== 'scanned') return null;
  entry.previousStatus = entry.status;
  entry.status = 'approving';
  return entry;
}

/** Rend la session à son statut d'avant [beginApproval] si l'approbation échoue. */
function abortApproval(sessionId) {
  const entry = _getEntry(sessionId);
  if (!entry || entry.status !== 'approving') return null;
  entry.status = entry.previousStatus ?? 'pending';
  return entry;
}

function approve(sessionId, { scannedByAlanyaID, result } = {}) {
  const entry = _getEntry(sessionId);
  // Expirée pendant les await de l'approbation : l'appelant DOIT tester ce
  // retour, sinon il annonce une approbation dont personne ne verra les tokens.
  if (!entry || entry.status !== 'approving') return null;
  entry.status = 'approved';
  if (scannedByAlanyaID != null) entry.scannedByAlanyaID = scannedByAlanyaID;
  entry.result = result ?? null;
  return entry;
}

function deny(sessionId) {
  const entry = _getEntry(sessionId);
  if (!entry) return null;
  entry.status = 'denied';
  entry.result = null;
  // On garde l'entrée jusqu'au TTL : l'appareil demandeur doit pouvoir lire
  // « refusé » à son prochain poll. La supprimer lui afficherait « expiré »,
  // message trompeur. Le plafond de _sweep borne déjà la croissance.
  return entry;
}

function clear(sessionId) {
  if (sessionId == null) return;
  _sessions.delete(sessionId);
}

module.exports = {
  TTL_MS, create, get, markScanned, beginApproval, abortApproval, approve, deny, clear,
};
