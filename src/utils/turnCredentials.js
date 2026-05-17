// src/utils/turnCredentials.js
//
// Construit la liste iceServers (STUN/TURN) à servir aux clients via
// /api/turn/credentials. Les credentials TURN ne doivent plus vivre côté
// client — on les centralise ici, lus depuis env, pour pouvoir les roter.
//
// Variables d'environnement supportées :
//   TURN_URLS        CSV des URLs TURN (ex: "turn:host:80,turns:host:443?transport=tcp")
//   TURN_USERNAME    Username TURN long-lived (mode static)
//   TURN_CREDENTIAL  Credential TURN long-lived (mode static)
//   TURN_SECRET      Secret partagé coturn (mode REST API éphémère, HMAC-SHA1)
//   TURN_TTL_SEC     TTL des credentials éphémères (défaut 3600)
//
// Si TURN_SECRET est défini, on génère des credentials éphémères (recommandé).
// Sinon, on utilise TURN_USERNAME/TURN_CREDENTIAL fixes.
// Si rien n'est défini, on retombe sur les STUN publics Google uniquement —
// les NAT symétriques échoueront mais l'app reste fonctionnelle sur la plupart
// des réseaux.

const crypto = require('crypto');

const DEFAULT_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const parseTurnUrls = () => {
  const raw = (process.env.TURN_URLS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
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
  const turnUrls = parseTurnUrls();

  if (turnUrls.length === 0) {
    return { iceServers: DEFAULT_STUN, ttlSec: 0 };
  }

  let username;
  let credential;
  let ttlSec = 0;

  if (process.env.TURN_SECRET) {
    const ttl = parseInt(process.env.TURN_TTL_SEC, 10) || 3600;
    const eph = generateEphemeralCredentials(String(userId), ttl);
    username = eph.username;
    credential = eph.credential;
    ttlSec = ttl;
  } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    username = process.env.TURN_USERNAME;
    credential = process.env.TURN_CREDENTIAL;
  } else {
    return { iceServers: DEFAULT_STUN, ttlSec: 0 };
  }

  return {
    iceServers: [
      ...DEFAULT_STUN,
      { urls: turnUrls, username, credential },
    ],
    ttlSec,
  };
};

module.exports = { buildIceServers };
