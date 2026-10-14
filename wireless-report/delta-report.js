// DELTA wireless-report - SINGLE FILE (self-contained website)
// Generated from report-server.js + public/ index.html, style.css, app.js
// Run: node delta-report.js   (port 8081; reads DATABASE_URL like the multi-file server)
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
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DELTA \\u2014 Session Report</title>
  <style>:root {
  --bg: #0b1220;
  --panel: #111a2e;
  --card: #16213a;
  --line: #23314f;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --green: #22c55e;
  --amber: #f59e0b;
  --red: #ef4444;
  --accent: #38bdf8;
}

* { box-sizing: border-box; }

html, body {
  height: 100%;
  margin: 0;
  touch-action: manipulation;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  padding: 16px;
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
header h1 { font-size: 20px; margin: 0; }

.db-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--muted);
}
.db-dot.ok { background: var(--green); }
.db-dot.err { background: var(--red); }

.controls {
  display: flex;
  gap: 12px;
  align-items: end;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.controls label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
select, button {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 14px;
}
button {
  cursor: pointer;
  background: var(--accent);
  color: #04212f;
  font-weight: 600;
  border-color: transparent;
}

.session {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 14px;
}
.session-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.session-title { font-size: 15px; font-weight: 600; }
.session-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }

.chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.chip {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--muted);
}
.chip b { color: var(--text); }

.stress-g { color: var(--green); }
.stress-a { color: var(--amber); }
.stress-r { color: var(--red); }

.seg-toggle {
  margin-top: 10px;
  background: var(--panel);
  color: var(--accent);
  border: 1px solid var(--line);
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 12px;
}
th, td {
  text-align: right;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
th { color: var(--muted); font-weight: 500; }
th:first-child, td:first-child { text-align: left; }
tr:last-child td { border-bottom: none; }
.row-seg { text-align: left; color: var(--muted); }
.segments-wrap { display: none; }
.segments-wrap.open { display: block; }

.empty { color: var(--muted); text-align: center; margin-top: 40px; }
.hidden { display: none; }

.seg-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 10px 0 0;
}</style>
</head>
<body>
  <header>
    <h1>DELTA Session Report</h1>
    <span id="db-status" class="db-dot" title="connection status"></span>
  </header>

  <section class="controls">
    <label>Student
      <select id="student-filter"><option value="">All students</option></select>
    </label>
    <label>Segment length
      <select id="seg-options">
        <option value="15">15 s</option>
        <option value="30">30 s</option>
        <option value="60" selected>1 min</option>
        <option value="300">5 min</option>
      </select>
    </label>
    <button id="refresh-btn">Refresh</button>
    <span class="seg-hint" style="align-self:center;">auto-refreshes every 15 s &mdash; completed sessions appear automatically</span>
  </section>

  <main id="sessions"></main>
  <p id="empty" class="empty hidden">No sessions recorded yet.</p>

  <script>const $ = (id) => document.getElementById(id);

const studentFilter = $("student-filter");
const segOptions = $("seg-options");
const sessionsEl = $("sessions");
const emptyEl = $("empty");

let sessionsCache = [];

const fmtT = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" }) : "\\\\u2014";

const fmtDuration = (a, b) => {
  if (!a || !b) return "\\\\u2014";
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? \\\`\\\${m} min \\\${s % 60} s\\\` : \\\`\\\${s} s\\\`;
};

function stressClass(v) {
  if (v === null || v === undefined) return "";
  return v < 50 ? "stress-g" : v < 75 ? "stress-a" : "stress-r";
}

function chip(label, value, cls) {
  const val = value === null || value === undefined ? "\\\\u2014" : value;
  return \\\`<span class="chip">\\\${label} <b class="\\\${cls || ""}">\\\${val}</b></span>\\\`;
}

function setDbStatus(ok) {
  const dot = $("db-status");
  dot.classList.toggle("ok", ok);
  dot.classList.toggle("err", !ok);
  dot.title = ok ? "database connected" : "database unreachable";
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(\\\`\\\${url} -> \\\${r.status}\\\`);
  return r.json();
}

async function toggleSegments(sessionId, button) {
  const wrap = document.getElementById(\\\`segs-\\\${sessionId}\\\`);
  const open = wrap.classList.toggle("open");
  button.textContent = open ? "Hide segments" : "Show segments";
  if (!open) return;

  const segSec = Number(segOptions.value);
  const hint = wrap.querySelector(".seg-hint");
  const table = wrap.querySelector("table");
  try {
    const data = await fetchJSON(\\\`/api/sessions/\\\${sessionId}/segments?seg=\\\${segSec}\\\`);
    const rows = data.segments
      .map((g) => {
        const stress = g.stress_pct;
        return \\\`<tr>
          <td class="row-seg">\\\${g.seg}</td>
          <td>\\\${new Date(g.start).toLocaleTimeString([])}</td>
          <td>\\\${new Date(g.end).toLocaleTimeString([])}</td>
          <td>\\\${g.sample_count}</td>
          <td>\\\${g.electrolytes_pct ?? "\\\\u2014"}</td>
          <td>\\\${g.hydration_pct ?? "\\\\u2014"}</td>
          <td class="\\\${stressClass(stress)}">\\\${stress ?? "\\\\u2014"}</td>
          <td>\\\${g.sodium_meq_l ?? "\\\\u2014"}</td>
          <td>\\\${g.lactate_mmol_l ?? "\\\\u2014"}</td>
          <td>\\\${g.temperature_c ?? "\\\\u2014"}</td>
        </tr>\\\`;
      })
      .join("");
    table.innerHTML = rows || '<tr><td colspan="10" class="seg-hint">No measurements in this session.</td></tr>';
    hint.textContent = data.session.sample_count
      ? \\\`\\\${data.session.sample_count} measurements (within the \\\${data.mon_window_s}s monitoring window) sliced into \\\${data.segments.length} segment(s) \\\\u00d7 \\\${segSec}s\\\`
      : "";
  } catch (e) {
    table.innerHTML = \\\`<tr><td colspan="10">Failed to load segments: \\\${e.message}</td></tr>\\\`;
  }
}

async function toggleMeasurements(sessionId, button) {
  const wrap = document.getElementById(\\\`meas-\\\${sessionId}\\\`);
  const open = wrap.classList.toggle("open");
  button.textContent = open ? "Hide measurements" : "View all measurements";
  if (!open) return;

  const hint = wrap.querySelector(".seg-hint");
  const table = wrap.querySelector("table");
  try {
    const data = await fetchJSON(\\\`/api/sessions/\\\${sessionId}/measurements\\\`);
    const rows = data
      .map((r) => {
        const stress = r.stress_pct;
        return \\\`<tr>
          <td class="row-seg">\\\${new Date(r.recorded_at).toLocaleString([])}</td>
          <td>\\\${r.electrolytes_pct ?? "\\\\u2014"}</td>
          <td>\\\${r.hydration_pct ?? "\\\\u2014"}</td>
          <td class="\\\${stressClass(stress)}">\\\${stress ?? "\\\\u2014"}</td>
          <td>\\\${r.sodium_meq_l ?? "\\\\u2014"}</td>
          <td>\\\${r.lactate_mmol_l ?? "\\\\u2014"}</td>
          <td>\\\${r.temperature_c ?? "\\\\u2014"}</td>
        </tr>\\\`;
      })
      .join("");
    table.innerHTML = rows || '<tr><td colspan="7" class="seg-hint">No measurements captured in this session.</td></tr>';
    hint.textContent = data.length ? \\\`\\\${data.length} measurement(s) captured during this session\\\` : "";
  } catch (e) {
    table.innerHTML = \\\`<tr><td colspan="7">Failed to load: \\\${e.message}</td></tr>\\\`;
  }
}

function renderSession(s) {
  const stress = s.stress_pct;
  const card = document.createElement("div");
  card.className = "session";
  card.innerHTML = \\\`
    <div class="session-head">
      <div>
        <div class="session-title">\\\${s.student_name || "Unknown student"} \\\\u00b7 session #\\\${s.id}</div>
        <div class="session-sub">\\\${fmtT(s.started_at)} \\\\u2192 \\\${fmtT(s.ended_at)} \\\\u00b7 \\\${fmtDuration(s.started_at, s.ended_at)}</div>
      </div>
      <button class="seg-toggle" data-id="\\\${s.id}">Show segments</button>
    </div>
    <div class="chips">
      \\\${chip("samples", s.sample_count)}
      \\\${chip("electrolytes %", s.electrolytes_pct)}
      \\\${chip("hydration %", s.hydration_pct)}
      \\\${chip("stress %", s.stress_pct, stressClass(stress))}
      \\\${chip("sodium mEq/L", s.sodium_meq_l)}
      \\\${chip("lactate mmol/L", s.lactate_mmol_l)}
      \\\${chip("temp \\\\u00b0C", s.temperature_c)}
    </div>
    <div class="segments-wrap" id="segs-\\\${s.id}">
      <p class="seg-hint"></p>
      <table>
        <thead>
          <tr>
            <th>segment</th><th>start</th><th>end</th><th>n</th>
            <th>electro %</th><th>hydr %</th><th>stress %</th>
            <th>Na+</th><th>lactate</th><th>temp</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <button class="seg-toggle meas-toggle" data-id="\\\${s.id}">View all measurements</button>
    <div class="segments-wrap" id="meas-\\\${s.id}">
      <p class="seg-hint"></p>
      <table>
        <thead>
          <tr>
            <th>recorded at</th><th>electro %</th><th>hydr %</th><th>stress %</th>
            <th>Na+</th><th>lactate</th><th>temp</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>\\\`;
  card.querySelector(".seg-toggle").addEventListener("click", (e) =>
    toggleSegments(s.id, e.currentTarget)
  );
  card.querySelector(".meas-toggle").addEventListener("click", (e) =>
    toggleMeasurements(s.id, e.currentTarget)
  );
  return card;
}

let loading = false;

async function load() {
  if (loading) return;
  loading = true;
  try {
    const [health, students, sessions] = await Promise.all([
      fetchJSON("/api/health"),
      fetchJSON("/api/students"),
      fetchJSON("/api/sessions"),
    ]);
    setDbStatus(health.ok);
    if (health.ok) setDbStatus(true);

    const current = studentFilter.value;
    const kept = new Set(studentFilter.querySelectorAll("option")).size > 1;
    studentFilter.innerHTML = '<option value="">All students</option>';
    for (const st of students) {
      const op = document.createElement("option");
      op.value = st.id;
      op.textContent = \\\`\\\${st.name} (\\\${st.student_code})\\\`;
      studentFilter.appendChild(op);
    }
    if (kept) studentFilter.value = current;

    sessionsCache = sessions;
    render();
  } catch (e) {
    setDbStatus(false);
    sessionsEl.innerHTML = \\\`<div class="empty">Failed to load: \\\${e.message}</div>\\\`;
  } finally {
    loading = false;
  }
}

function render() {
  sessionsEl.innerHTML = "";
  const list = studentFilter.value
    ? sessionsCache.filter((s) => String(s.student_id) === studentFilter.value)
    : sessionsCache;
  list.forEach((s) => sessionsEl.appendChild(renderSession(s)));
  emptyEl.classList.toggle("hidden", list.length > 0);
}

studentFilter.addEventListener("change", render);
$("refresh-btn").addEventListener("click", load);
setInterval(load, 15000); /* every 15 s: completed sessions upload automatically */
load();</script>
</body>
</html>`;

app.get("/", (_req, res) => res.type("html").send(PAGE));

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