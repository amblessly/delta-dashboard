"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const envPath = path.join(__dirname, ".env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log("Connected to DB.");

  await c.query("DROP TABLE IF EXISTS measurements CASCADE");
  await c.query("DROP TABLE IF EXISTS detection_sessions CASCADE");
  await c.query("DROP TABLE IF EXISTS face_embeddings CASCADE");
  await c.query("DROP TABLE IF EXISTS students CASCADE");
  await c.query("DROP SEQUENCE IF EXISTS student_code_seq CASCADE");
  console.log("All tables and sequences dropped.");

  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await c.query(sql);
  await c.query("ALTER TABLE students ADD COLUMN IF NOT EXISTS photo TEXT");
  console.log("Schema re-applied OK.");

  const { rows } = await c.query("SELECT count(*) AS cnt FROM students");
  console.log("Students now:", rows[0].cnt);
  await c.end();
  console.log("Database reset complete.");
})();
