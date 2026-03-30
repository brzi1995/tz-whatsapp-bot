const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function seed() {
  const pool = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    const passwordHash = bcrypt.hashSync('123456', 10);
    const [result] = await pool.query(
      'INSERT IGNORE INTO users (email, password, tenant_id) VALUES (?, ?, ?)',
      ['admin@brela.hr', passwordHash, 1]
    );

    if (result.affectedRows === 0) {
      console.log('[seed] User admin@brela.hr already exists — skipped.');
    } else {
      console.log('[seed] User admin@brela.hr inserted successfully.');
    }
  } catch (err) {
    console.error('[seed] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
