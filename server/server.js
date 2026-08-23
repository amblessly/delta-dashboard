/* Project DELTA dashboard server:
   - serves the static dashboard (health-dashboard/) at http://localhost:8000
   - JSON API backed by Neon PostgreSQL:
       GET  /api/health
       GET  /api/student
       GET  /api/measurements?limit=50
       POST /api/sessions            {clientKey, studentName}
       POST /api/sessions/end        {clientKey}
       POST /api/measurements        {sessionClientKey, studentName, metrics{...}}
   Start: npm start   (reads server/.env)
*/
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* ── .env ─────────────────────────────────────────────────────── */
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  }
})();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing - create server/.env");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8000);
const STATIC_ROOT = path.join(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

/* ── Helpers ──────────────────────────────────────────────────── */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => {
      data += c;
      if (data.length > 1e6) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(STATIC_ROOT, rel));
  if (!filePath.startsWith(STATIC_ROOT)) {           /* path traversal guard */
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ── API handlers ─────────────────────────────────────────────── */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === "/api/health" && req.method === "GET") {
    await pool.query("SELECT 1");
    return sendJSON(res, 200, { ok: true, db: "connected" });
  }

  if (p === "/api/student" && req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT id, name, age, weight_kg FROM students ORDER BY id DESC LIMIT 1");
    return sendJSON(res, 200, rows[0] || null);
  }

  if (p === "/api/sessions" && req.method === "POST") {
    const body = await readBody(req);
    const key = typeof body.clientKey === "string" ? body.clientKey.slice(0, 64) : null;
    if (!key) return sendJSON(res, 400, { error: "clientKey required" });
    const { rows } = await pool.query(
      `INSERT INTO detection_sessions (client_key, student_name)
       VALUES ($1, $2)
       ON CONFLICT (client_key) DO UPDATE SET ended_at = NULL
       RETURNING id, client_key, started_at`,
      [key, body.studentName ? String(body.studentName).slice(0, 120) : null]
    );
    return sendJSON(res, 201, rows[0]);
  }

  if (p === "/api/sessions/end" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.clientKey) return sendJSON(res, 400, { error: "clientKey required" });
    const { rowCount } = await pool.query(
      `UPDATE detection_sessions SET ended_at = now()
       WHERE client_key = $1 AND ended_at IS NULL`,
      [String(body.clientKey).slice(0, 64)]
    );
    return sendJSON(res, 200, { updated: rowCount });
  }

  if (p === "/api/measurements" && req.method === "POST") {
    const b = await readBody(req);
    const m = b.metrics || {};
    const { rows } = await pool.query(
      `INSERT INTO measurements
         (session_client_key, student_name,
          electrolytes_pct, hydration_pct, stress_pct,
          sodium_meq_l, lactate_mmol_l, temperature_c)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, recorded_at`,
      [
        b.sessionClientKey ? String(b.sessionClientKey).slice(0, 64) : null,
        b.studentName ? String(b.studentName).slice(0, 120) : null,
        num(m.electrolytes), num(m.hydration), num(m.stress),
        num(m.sodium), num(m.lactate), num(m.temperature),
      ]
    );
    return sendJSON(res, 201, rows[0]);
  }

  if (p === "/api/measurements" && req.method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const { rows } = await pool.query(
      `SELECT * FROM measurements ORDER BY recorded_at DESC LIMIT $1`, [limit]);
    return sendJSON(res, 200, rows);
  }

  sendJSON(res, 404, { error: "Unknown API endpoint" });
}

/* ── Server ───────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error("[server]", e.message);
    if (!res.headersSent) sendJSON(res, 500, { error: "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[server] Project DELTA dashboard -> http://localhost:${PORT}`);
  console.log("[server] API: /api/health /api/student /api/measurements /api/sessions");
});
