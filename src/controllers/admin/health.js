/**
 * État du service pour l'admin — le versant que la supervision externe ne peut
 * pas voir.
 *
 * Une sonde qui interroge `/health` sait dire si le serveur répond. Elle ne
 * saura jamais qu'un job de purge échoue chaque nuit depuis une semaine, que la
 * file s'allonge, ou que le pool de connexions sature : de l'extérieur, tout va
 * bien. C'est ce que cette route expose, et rien d'autre — elle ne remplace pas
 * l'alerte, elle la complète.
 *
 * Contrairement à `/health`, la réponse est ici détaillée (messages d'erreur
 * des jobs compris) : elle est derrière `adminAuth`.
 */

const pool = require('../../config/db');
const jobQueue = require('../../services/jobQueue');
const registry = require('../../services/purgeRegistry');
const { REDIS_ENABLED } = require('../../config/redis');
const { getDataClient } = require('../../config/redisData');

/**
 * Occupation du pool MySQL. mysql2 n'expose pas de compteurs publics : on lit
 * les tableaux internes du pool sous-jacent. Ce sont des propriétés privées, et
 * une montée de version peut les renommer — d'où le repli sur `null` plutôt
 * qu'une exception, la santé du service ne devant jamais dépendre de la forme
 * interne d'une bibliothèque.
 */
function etatDuPool() {
  const taille = Number(process.env.DB_POOL_SIZE) || 25;
  const p = pool.pool || pool;
  const toutes = p?._allConnections?.length;
  const libres = p?._freeConnections?.length;
  const enFile = p?._connectionQueue?.length;
  if ([toutes, libres, enFile].some((v) => typeof v !== 'number')) {
    return { taille, mesurable: false };
  }
  return {
    taille,
    mesurable: true,
    ouvertes: toutes,
    libres,
    // Une connexion ouverte et non libre est en train de servir une requête.
    occupees: toutes - libres,
    // Non nul = le pool est saturé et des requêtes patientent. C'est le seul
    // de ces chiffres qui constitue à lui seul une anomalie.
    enAttente: enFile,
  };
}

async function etatRedis() {
  if (!REDIS_ENABLED) return { configure: false, connecte: false };
  const client = getDataClient();
  if (!client) return { configure: true, connecte: false };
  try {
    await client.ping();
    return { configure: true, connecte: true };
  } catch (e) {
    console.error('[AdminHealth] ping Redis:', e.message);
    return { configure: true, connecte: false };
  }
}

/** Admin : file de jobs, purges, Redis, pool MySQL. */
const getServiceHealth = async (_req, res) => {
  try {
    // En parallèle : trois lectures indépendantes, dont deux touchent la base.
    const [jobs, purges, redis] = await Promise.all([
      jobQueue.stats(),
      registry.lastRunPerPurge(),
      etatRedis(),
    ]);

    res.json({
      jobs,
      purges,
      redis,
      mysql: etatDuPool(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Admin] getServiceHealth error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getServiceHealth };
