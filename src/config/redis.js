const { createClient } = require('redis');
require('dotenv').config();

// Absent par défaut : adapter Socket.IO en mémoire, mono-instance uniquement
// (voir server.js). Une fois défini, le serveur DOIT pouvoir s'y connecter
// au démarrage — une valeur injoignable fait échouer le démarrage plutôt que
// de tourner silencieusement en mode dégradé où le fan-out cross-instance ne
// fonctionnerait pas.
const REDIS_URL = process.env.REDIS_URL || null;
const REDIS_ENABLED = !!REDIS_URL;

/**
 * Un client `redis` non connecté, prêt pour `.connect()`. `name` sert
 * uniquement au log d'erreur (ex. 'pub', 'sub').
 */
function createRedisClient(name) {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error(`[Redis:${name}] erreur:`, e.message));
  return client;
}

/**
 * `client.connect()` ne rejette jamais tout seul contre un Redis injoignable
 * — la stratégie de reconnexion par défaut du client `redis` v4 réessaie
 * indéfiniment, y compris pour la toute première tentative, et la promesse
 * reste indéfiniment en attente (vérifié directement : aucune des deux issues
 * possibles, résolution ou rejet, ne survient). Un délai explicite est donc
 * nécessaire pour transformer une connexion injoignable en échec net au
 * démarrage plutôt qu'un blocage silencieux.
 */
function connectWithTimeout(client, ms, label) {
  return Promise.race([
    client.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`délai dépassé (${ms}ms) pour ${label}`)), ms),
    ),
  ]);
}

module.exports = { REDIS_URL, REDIS_ENABLED, createRedisClient, connectWithTimeout };
