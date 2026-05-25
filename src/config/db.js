const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'talky',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // mysql2 interprète/sérialise les DATETIME en UTC ("...Z" en JSON).
  timezone: 'Z',
});

// Force chaque connexion en UTC pour que NOW() écrive en UTC et que les
// lectures soient cohérentes quel que soit le fuseau de l'hôte. Combiné à
// timezone:'Z', toute la chaîne sendAt/lastMessageAt est en UTC, et les
// clients font .toLocal() pour l'affichage.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

module.exports = pool;