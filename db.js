// db.js
const { Pool } = require('pg');

// Use environment variables for database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'k6o4.your-database.de',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'albastxz_db1',
  user: process.env.DB_USER || 'albastxz_1',
  password: process.env.DB_PASSWORD, // This is required
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Test the connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL connection error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};