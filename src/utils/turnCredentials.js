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
    const ttl = parseInt(process.env.TURN_TTL_SEC, 10) || 3600;
    const eph = generateEphemeralCredentials(String(userId), ttl);
    
    iceServers = turnServers.map(server => ({
      urls: server.urls,
      username: eph.username,
      credential: eph.credential,
    }));
    
    ttlSec = ttl;
  } else { 
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
