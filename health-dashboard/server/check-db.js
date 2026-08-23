"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const t = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
  );
  console.log("TABLES:", t.rows.map(r => r.table_name).join(", "));
  const s = await c.query("SELECT COUNT(*)::int AS n FROM detection_sessions");
  const m = await c.query("SELECT COUNT(*)::int AS n FROM measurements");
  const st = await c.query("SELECT name, age, weight_kg FROM students ORDER BY id");
  console.log("sessions:", s.rows[0].n, "| measurements:", m.rows[0].n);
  for (const r of st.rows) console.log("student:", r.name, "|", r.age, "yrs |", r.weight_kg, "kg");
  await c.end();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
