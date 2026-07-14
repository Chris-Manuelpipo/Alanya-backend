/**
 * Extrait l'adresse IP client depuis une requête Express ou un socket Socket.IO.
 */
function getClientIp(reqOrSocket) {
  const req = reqOrSocket.request ?? reqOrSocket;
  const forwarded = req.headers?.['x-forwarded-for'];
  return (
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
    req.connection?.remoteAddress ||
    reqOrSocket.handshake?.address ||
    null
  );
}

/**
 * Valide et normalise le mode de connexion WebRTC (0=relay, 1=P2P).
 * Retourne null si absent ou invalide.
 */
function parseCallMode(value) {
  if (value === undefined || value === null) return null;
  const n = parseInt(value, 10);
  if (n === 0 || n === 1) return n;
  return null;
}

module.exports = { getClientIp, parseCallMode };  
