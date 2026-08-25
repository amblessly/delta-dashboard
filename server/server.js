/* Project DELTA local development server:
   - serves the static dashboard from the repository root at http://localhost:8000
   - exposes the SAME JSON API as the Vercel deployment (api/ folder):
       GET  /api/health
       GET  /api/students
       GET  /api/students/:code
       GET  /api/students/:code/health
       POST /api/students/enroll
       POST /api/face/match
       POST /api/sessions            {clientKey, studentCode}
       POST /api/sessions/end        {clientKey}
       GET  /api/measurements?limit=
       POST /api/measurements        (sensor ingestion; validated + source + timestamp)
   Start: npm start   (reads server/.env)
*/
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const lib = require("../api/_lib.js");

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
  console.error("DATABASE_URL missing - create server/.env (see server/.env.example)");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8000);
const STATIC_ROOT = __dirname ? path.join(__dirname, "..") : process.cwd();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: 1,               /* keep one warm connection - avoids cold-connect timeouts */
  max: 5,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 15000,
  ssl: { rejectUnauthorized: false },
});

/* Neon drops idle connections periodically; without this handler an idle
   client 'error' crashes the whole process (unhandled 'error' event). */
pool.on("error", (err) => {
  console.error("[db] pool client error (recovering):", err.message);
});

/* Demo-day resilience: log fatal errors instead of dying. */
process.on("uncaughtException", (err) => console.error("[fatal] caught:", err.message));
process.on("unhandledRejection", (err) => console.error("[rejection]:", (err && err.message) || err));

/* Idempotent schema migration at boot. */
lib.ensureSchema(pool)
  .then(() => console.log("[server] schema verified/migrated OK"))
  .catch(e => {
    console.error("[server] schema migration FAILED:", e.message);
    process.exit(1);
  });

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

/* ── API handlers (mirror api/ serverless functions) ──────────── */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === "/api/health" && method === "GET") {
    await pool.query("SELECT 1");
    return sendJSON(res, 200, { ok: true, db: "connected" });
  }

  if (p === "/api/students" && method === "GET") {
    return sendJSON(res, 200, await lib.listStudents(pool));
  }

  /* NOTE: static segment "enroll" is matched before the dynamic :code route. */
  if (p === "/api/students/enroll" && method === "POST") {
    const b = await readBody(req);
    const result = await lib.enrollStudent(pool, b);
    if (result.error) return sendJSON(res, 400, result);
    if (result.conflict) {
      return sendJSON(res, 409, { error: "This face is already registered.", student: result.student });
    }
    return sendJSON(res, 201, result.student);
  }

  if (p === "/api/face/match" && method === "POST") {
    const b = await readBody(req);
    const result = await lib.matchFace(pool, b.descriptor);
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 200, result);
  }

  const codeHealth = p.match(/^\/api\/students\/([^/]+)\/health$/);
  if (codeHealth && method === "GET") {
    const result = await lib.getHealthByCode(pool, codeHealth[1]);
    if (result.error) return sendJSON(res, 400, result);
    if (result.notFound) return sendJSON(res, 404, { error: "Student not found" });
    return sendJSON(res, 200, result);
  }

  const codeRoute = p.match(/^\/api\/students\/([^/]+)$/);
  if (codeRoute && method === "GET") {
    const result = await lib.getStudentByCode(pool, codeRoute[1]);
    if (result.error) return sendJSON(res, 400, result);
    if (result.notFound) return sendJSON(res, 404, { error: "Student not found" });
    return sendJSON(res, 200, result.student);
  }

  if (p === "/api/sessions" && method === "POST") {
    const b = await readBody(req);
    const result = await lib.startSession(pool, b);
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 201, result);
  }

  if (p === "/api/sessions/end" && method === "POST") {
    const b = await readBody(req);
    const result = await lib.endSession(pool, b.clientKey);
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 200, result);
  }

  if (p === "/api/measurements" && method === "POST") {
    const b = await readBody(req);
    const result = await lib.insertMeasurement(pool, b);
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 201, result);
  }

  if (p === "/api/measurements" && method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const { rows } = await pool.query(
      `SELECT m.id, s.student_code AS "studentCode", m.source,
              m.electrolytes_pct, m.hydration_pct, m.stress_pct,
              m.sodium_meq_l, m.lactate_mmol_l, m.temperature_c,
              m.recorded_at AS "recordedAt"
       FROM measurements m LEFT JOIN students s ON s.id = m.student_id
       ORDER BY m.recorded_at DESC LIMIT $1`, [limit]);
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
  console.log("[server] API: /api/health /api/students /api/students/:code /api/students/:code/health");
  console.log("[server]     /api/students/enroll /api/face/match /api/sessions /api/measurements");
});
