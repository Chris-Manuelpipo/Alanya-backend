const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'talky',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 25,
  // File d'attente bornée : sous saturation on veut échouer vite (erreur explicite)
  // plutôt qu'empiler des requêtes en mémoire avec une latence infinie.
  queueLimit: Number(process.env.DB_QUEUE_LIMIT) || 200,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // Pas de maxIdle/idleTimeout : maxIdle < connectionLimit fait démarrer un
  // setInterval interne dans mysql2 qui empêche tout script one-shot (tests,
  // scripts/) de se terminer naturellement.
  timezone: 'Z',
});

pool.on('connection', (conn) => {
  // `connection` expose la connexion callback sous-jacente (pas l'API promesse).
  // max_execution_time (ms) ne s'applique qu'aux SELECT : garde-fou contre une
  // requête de lecture pathologique qui monopoliserait une connexion.
  //
  // transaction_isolation en READ COMMITTED (au lieu du REPEATABLE READ par
  // défaut de MySQL) : réduit les verrous d'intervalle (gap locks) posés par
  // les UPDATE sur des plages, comme les accusés de lecture/livraison
  // (`UPDATE message ... WHERE conversationID = ? AND status < 3`), sans
  // changer la sémantique applicative — aucune requête de ce backend ne
  // dépend de la répétabilité d'une lecture au sein d'une même transaction.
  // Réglage par connexion (pas SET GLOBAL) : ne s'applique qu'à ce pool, pas
  // à d'éventuels autres consommateurs de la même base.
  conn.query(
    "SET time_zone = '+00:00', SESSION max_execution_time = 5000, SESSION transaction_isolation = 'READ-COMMITTED'",
    (e) => {
      if (e) console.error('[DB pool] init connexion échouée:', e.message);
    },
  );
});

pool.on('error', (e) => {
  console.error('[DB pool] erreur:', e.code, e.message);
});

module.exports = pool;
