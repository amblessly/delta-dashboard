/* Assign session ids to historical readings posted before session linking
   existed (session_client_key IS NULL).

   A reading is only assigned when EXACTLY ONE session window contains it,
   so ambiguous periods are reported instead of guessed. Nothing is ever
   deleted, and the website does not depend on this having been run: the
   dashboard matches those readings by session window at query time.

   Dry run (default - reports only):
     node link-historical-sessions.js

   Apply (writes session_client_key):
     node link-historical-sessions.js --apply

   Show the first N candidate readings:
     node link-historical-sessions.js --explain 20
*/
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { SESSION_FALLBACK_WINDOW_SECONDS, readingInsideWindowSql } = require("../api/_lib.js");

const apply = process.argv.includes("--apply");
const explainIndex = process.argv.indexOf("--explain");
const explainCount = explainIndex > -1 ? Number(process.argv[explainIndex + 1]) || 20 : 0;

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    console.error("DATABASE_URL not set and no server/.env found (see server/.env.example)");
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

/* A reading belongs to session d when it falls inside [started_at, ended_at)
   (or the first windowSec after start while the session is still open).
   Same rule the website uses, so a dry run predicts the real result. */
function insideWindow(m, d) {
  return readingInsideWindowSql(m, d, SESSION_FALLBACK_WINDOW_SECONDS);
}

function keyFor(m) {
  return "(SELECT d.client_key FROM detection_sessions d WHERE " + insideWindow(m, "d") + ")";
}

function candidates(comparison) {
  return "FROM measurements m WHERE m.session_client_key IS NULL"
    + " AND (SELECT COUNT(*) FROM detection_sessions d WHERE " + insideWindow("m", "d") + ") " + comparison;
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) process.exit(1);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on("error", () => {});

  const totals = await pool.query(
    "SELECT COUNT(*)::int AS all_readings,"
    + " COUNT(*) FILTER (WHERE session_client_key IS NOT NULL)::int AS already_linked,"
    + " COUNT(*) FILTER (WHERE session_client_key IS NULL)::int AS unlinked FROM measurements"
  );
  const counts = await pool.query(
    "SELECT COUNT(*) FILTER (WHERE matches = 1)::int AS linkable,"
    + " COUNT(*) FILTER (WHERE matches > 1)::int AS ambiguous,"
    + " COUNT(*) FILTER (WHERE matches = 0)::int AS outside"
    + " FROM (SELECT (SELECT COUNT(*) FROM detection_sessions d WHERE "
    + insideWindow("m", "d") + ") AS matches " + candidates(">= 0") + ") x"
  );
  const { all_readings: all, already_linked: linked, unlinked } = totals.rows[0];
  const { linkable, ambiguous, outside } = counts.rows[0];

  console.log("=== Project DELTA - link historical readings to sessions ===");
  console.log("mode:            " + (apply ? "APPLY (writes session_client_key)" : "DRY RUN (no changes)"));
  console.log("window rule:     recorded_at within the session, +" + SESSION_FALLBACK_WINDOW_SECONDS + "s if still open");
  console.log("total readings:  " + all);
  console.log("already linked:  " + linked);
  console.log("without a key:   " + unlinked);
  console.log("");
  console.log("  linkable (exactly one session): " + linkable);
  console.log("  ambiguous (overlapping sessions): " + ambiguous);
  console.log("  outside every session window:   " + outside);
  console.log("");

  if (apply) {
    const result = await pool.query(
      "UPDATE measurements m SET session_client_key = x.client_key FROM ("
      + " SELECT m2.id, " + keyFor("m2") + " AS client_key FROM measurements m2"
      + " WHERE m2.session_client_key IS NULL) x"
      + " WHERE m.id = x.id AND x.client_key IS NOT NULL"
      + " AND (SELECT COUNT(*) FROM detection_sessions d WHERE " + insideWindow("m", "d") + ") = 1"
    );
    console.log("updated readings: " + result.rowCount);
  } else {
    console.log("Dry run: nothing was written. Re-run with --apply to store these session ids.");
  }

  const perSession = await pool.query(
    "SELECT d.client_key, d.started_at, COUNT(m.id)::int AS matches"
    + " FROM detection_sessions d JOIN measurements m ON " + insideWindow("m", "d")
    + " WHERE m.session_client_key IS NULL"
    + " GROUP BY d.id, d.client_key, d.started_at ORDER BY d.started_at DESC LIMIT 15"
  );
  if (perSession.rows.length) {
    console.log("");
    console.log("sessions holding readings without a key (newest first):");
    for (const row of perSession.rows) {
      console.log("  " + row.client_key + "  " + row.started_at.toISOString()
        + "  " + String(row.matches).padStart(5) + " readings");
    }
  }

  if (explainCount > 0) {
    const sample = await pool.query(
      "SELECT m.id, m.recorded_at, m.source, " + keyFor("m") + " AS session_id "
      + candidates("= 1") + " ORDER BY m.recorded_at LIMIT $1",
      [explainCount]
    );
    console.log("");
    console.log("first " + sample.rows.length + " readings that would be linked:");
    for (const row of sample.rows) console.log("  " + JSON.stringify(row));
  }

  await pool.end();
}

main().catch(e => {
  console.error("FAILED:", e.message);
  process.exit(1);
});