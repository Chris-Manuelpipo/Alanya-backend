// src/utils/turnCredentials.js
//
// Construit la liste iceServers (STUN/TURN) à servir aux clients via
// /api/turn/credentials. Les credentials TURN ne doivent plus vivre côté
// client — on les centralise ici, lus depuis env, pour pouvoir les roter.
//
// Variables d'environnement supportées :
//   TURN_SERVERS     JSON array de serveurs TURN avec credentials
//   TURN_SECRET      Secret partagé coturn (mode REST API éphémère, HMAC-SHA1) - optionnel
//   TURN_TTL_SEC     TTL des credentials éphémères (défaut 3600) - optionnel
//
// Format TURN_SERVERS:
// [
//   {
//     "urls": ["turn:host:80", "turn:host:80?transport=tcp"],
//     "username": "user1",
//     "credential": "pass1"
//   },
//   {
//     "urls": ["turn:host2:3478"],
//     "username": "user2",
//     "credential": "pass2"
//   }
// ]
//
// Si TURN_SECRET est défini, on génère des credentials éphémères (recommandé).
// Sinon, on utilise les credentials statiques de chaque serveur.
// Si rien n'est défini, on retombe sur les STUN publics Google uniquement.

const crypto = require('crypto');

const DEFAULT_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const parseTurnServers = () => {
  const raw = (process.env.TURN_SERVERS || '').trim();
  if (!raw) return [];
  
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(server => 
        server.urls && 
        Array.isArray(server.urls) && 
        server.urls.length > 0 &&
        server.username &&
        server.credential
      );
    }
  } catch (e) {
    console.error('[TURN] Failed to parse TURN_SERVERS JSON:', e.message);
  }
  return [];
};

const generateEphemeralCredentials = (userId, ttlSec) => {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${userId}`;
  const hmac = crypto.createHmac('sha1', process.env.TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');
  return { username, credential, ttlSec };
};

const buildIceServers = (userId) => {
  const turnServers = parseTurnServers();

  if (turnServers.length === 0) {
    return { iceServers: DEFAULT_STUN, ttlSec: 0 };
  }

  let iceServers;
  let ttlSec = 0;

  if (process.env.TURN_SECRET) {
    // Mode éphémère: générer credentials pour chaque serveur
    const ttl = parseInt(process.env.TURN_TTL_SEC, 10) || 3600;
    const eph = generateEphemeralCredentials(String(userId), ttl);
    
    iceServers = turnServers.map(server => ({
      urls: server.urls,
      username: eph.username,
      credential: eph.credential,
    }));
    
    ttlSec = ttl;
  } else {
    // Mode statique: utiliser les credentials de chaque serveur
    iceServers = turnServers.map(server => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential,
    }));
  }

  return {
    iceServers: [...DEFAULT_STUN, ...iceServers],
    ttlSec,
  };
};

module.exports = { buildIceServers };
