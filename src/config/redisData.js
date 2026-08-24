/**
 * Client Redis « data » (état applicatif : pendingCalls, callDeviceOwnership,
 * callState, …) — distinct du client pub/sub de l'adapter Socket.IO
 * (src/config/redis.js), qui est réservé au protocole interne de l'adapter.
 * Connecté une seule fois au démarrage (server.js), récupéré ici par les
 * modules d'état qui n'ont pas accès au contexte de démarrage.
 */
let _client = null;

function setDataClient(client) {
  _client = client;
}

function getDataClient() {
  return _client;
}

module.exports = { setDataClient, getDataClient };
