const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'talky',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  // Après réduction SQL message:send, 15–20 est raisonnable sous charge.
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0, 
  timezone: 'Z',
});
 
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

module.exports = pool;