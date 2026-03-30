require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// Test connection on startup so misconfigured DB fails loudly
pool.getConnection()
  .then(conn => {
    console.log('[db] MySQL connection pool ready');
    conn.release();
  })
  .catch(err => {
    console.error('[db] FAILED to connect to MySQL:', err.message);
    console.error('[db] DB_HOST:', process.env.DB_HOST, '| DB_USER:', process.env.DB_USER, '| DB_NAME:', process.env.DB_NAME);
  });

module.exports = pool;
