const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8081);
const ROOT = __dirname;

function readEnvFrom(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch (e) {
    /* file optional */
  }
  return null;
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  readEnvFrom(path.join(ROOT, ".env")) ||
  readEnvFrom("/home/delta/delta-dashboard/server/.env");

if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL not found. Export it, add wireless-report/.env, or deploy alongside the dashboard's server/.env."
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const app = express();
app.use(express.static(path.join(ROOT, "public")));

const toNum = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return Number(v);
};

const MONITOR_WINDOW_S_DEFAULT = 15;
const clampWin = (v) => {
  const n = Math.floor(Number(v));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 3600) : MONITOR_WINDOW_S_DEFAULT;
};

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, db: e.message });
  }
});

app.get("/api/students", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, student_code, name FROM students ORDER BY created_at ASC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  const sid = req.query.student ? Number(req.query.student) : null;
  const winS = clampWin(req.query.win);
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.student_id, d.student_name, d.started_at, d.ended_at,
              COUNT(m.id)::int AS sample_count,
              ROUND(AVG(m.electrolytes_pct), 1) AS electrolytes_pct,
              ROUND(AVG(m.hydration_pct), 1) AS hydration_pct,
              ROUND(AVG(m.stress_pct), 1) AS stress_pct,
              ROUND(AVG(m.sodium_meq_l), 1) AS sodium_meq_l,
              ROUND(AVG(m.lactate_mmol_l), 2) AS lactate_mmol_l,
              ROUND(AVG(m.temperature_c), 1) AS temperature_c
         FROM detection_sessions d
         LEFT JOIN measurements m
           ON m.session_client_key = d.client_key
          AND m.recorded_at >= d.started_at
          AND m.recorded_at < d.started_at + make_interval(secs => $2)
        WHERE ($1::int IS NULL OR d.student_id = $1)
        GROUP BY d.id
        HAVING COUNT(m.id) > 0
        ORDER BY d.started_at DESC`,
      [sid, winS]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/measurements", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const s = await pool.query(
      "SELECT client_key FROM detection_sessions WHERE id = $1",
      [id]
    );
    if (!s.rows.length) return res.status(404).json({ error: "session not found" });
    const { rows } = await pool.query(
      `SELECT recorded_at, electrolytes_pct, hydration_pct, stress_pct,
              sodium_meq_l, lactate_mmol_l, temperature_c
         FROM measurements
        WHERE session_client_key = $1
        ORDER BY recorded_at ASC`,
      [s.rows[0].client_key]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/segments", async (req, res) => {
  const id = Number(req.params.id);
  const segSec = Math.max(1, Math.floor(Number(req.query.seg || 60)));
  const winS = clampWin(req.query.win);
  try {
    const s = await pool.query(
      `SELECT id, client_key, student_id, student_name, started_at, ended_at
         FROM detection_sessions WHERE id = $1`,
      [id]
    );
    if (!s.rows.length) return res.status(404).json({ error: "session not found" });
    const ses = s.rows[0];

    const m = await pool.query(
      `SELECT electrolytes_pct, hydration_pct, stress_pct, sodium_meq_l,
              lactate_mmol_l, temperature_c, recorded_at
         FROM measurements
        WHERE session_client_key = $1
          AND recorded_at >= (SELECT started_at FROM detection_sessions WHERE id = $2)
          AND recorded_at < (SELECT started_at FROM detection_sessions WHERE id = $2) + make_interval(secs => $3)
        ORDER BY recorded_at ASC`,
      [ses.client_key, id, winS]
    );

    const t0 = new Date(ses.started_at).getTime();
    const buckets = [];
    for (const r of m.rows) {
      const idx = Math.floor((new Date(r.recorded_at).getTime() - t0) / (segSec * 1000));
      if (idx < 0) continue;
      (buckets[idx] = buckets[idx] || []).push(r);
    }

    const segments = buckets.map((list, idx) => {
      const avg = (k) => {
        const vals = list.filter((r) => r[k] !== null && r[k] !== undefined).map((r) => Number(r[k]));
        if (!vals.length) return null;
        return +((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
      };
      return {
        seg: idx + 1,
        start: new Date(t0 + idx * segSec * 1000).toISOString(),
        end: new Date(t0 + (idx + 1) * segSec * 1000).toISOString(),
        sample_count: list.length,
        electrolytes_pct: avg("electrolytes_pct"),
        hydration_pct: avg("hydration_pct"),
        stress_pct: avg("stress_pct"),
        sodium_meq_l: avg("sodium_meq_l"),
        lactate_mmol_l: avg("lactate_mmol_l"),
        temperature_c: avg("temperature_c"),
      };
    });

    res.json({
      session: {
        id: ses.id,
        student_id: ses.student_id,
        student_name: ses.student_name,
        started_at: ses.started_at,
        ended_at: ses.ended_at,
        sample_count: m.rows.length,
      },
      seg_sec: segSec,
      mon_window_s: winS,
      segments,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wireless-report] DELTA session report -> http://0.0.0.0:${PORT}`);
});