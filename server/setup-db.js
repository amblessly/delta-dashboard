/* Applies schema.sql to the Neon database. Usage: npm run setup-db */
"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

/* Minimal .env loader (no extra dependency). */
function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    console.error("DATABASE_URL not set and no server/.env found.");
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  loadEnv();
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(sql);
    await client.query("ALTER TABLE students ADD COLUMN IF NOT EXISTS photo TEXT");
    console.log("[setup-db] Schema applied and photo column verified OK.");

    const { rows } = await client.query("SELECT id, name, age, weight_kg, (photo IS NOT NULL) AS has_photo FROM students ORDER BY id");
    console.log("[setup-db] current students in DB:", rows);

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log("[setup-db] tables:", tables.rows.map(r => r.table_name).join(", "));
  } catch (e) {
    console.error("[setup-db] FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
