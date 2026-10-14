/* Shared Neon pool for Vercel serverless functions */
const { Pool } = require("pg");

/* Initialize pool lazily (Vercel reuses containers) */
let _pool = null;
function pool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL env var required");
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

module.exports = { pool };