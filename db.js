// db.js
const { Pool } = require('pg');

const pool = new Pool({
  host: 'k6o4.your-database.de',
  port: 5432,
  database: 'albastxz_db1',
  user: 'albastxz_1',
  password: process.env.DB_PASSWORD, // Make sure to set this in Render
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};