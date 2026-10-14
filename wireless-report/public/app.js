const $ = (id) => document.getElementById(id);

const studentFilter = $("student-filter");
const segOptions = $("seg-options");
const sessionsEl = $("sessions");
const emptyEl = $("empty");

let sessionsCache = [];

const fmtT = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" }) : "\u2014";

const fmtDuration = (a, b) => {
  if (!a || !b) return "\u2014";
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
};

function stressClass(v) {
  if (v === null || v === undefined) return "";
  return v < 50 ? "stress-g" : v < 75 ? "stress-a" : "stress-r";
}

function chip(label, value, cls) {
  const val = value === null || value === undefined ? "\u2014" : value;
  return `<span class="chip">${label} <b class="${cls || ""}">${val}</b></span>`;
}

function setDbStatus(ok) {
  const dot = $("db-status");
  dot.classList.toggle("ok", ok);
  dot.classList.toggle("err", !ok);
  dot.title = ok ? "database connected" : "database unreachable";
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function toggleSegments(sessionId, button) {
  const wrap = document.getElementById(`segs-${sessionId}`);
  const open = wrap.classList.toggle("open");
  button.textContent = open ? "Hide segments" : "Show segments";
  if (!open) return;

  const segSec = Number(segOptions.value);
  const hint = wrap.querySelector(".seg-hint");
  const table = wrap.querySelector("table");
  try {
    const data = await fetchJSON(`/api/sessions/${sessionId}/segments?seg=${segSec}`);
    const rows = data.segments
      .map((g) => {
        const stress = g.stress_pct;
        return `<tr>
          <td class="row-seg">${g.seg}</td>
          <td>${new Date(g.start).toLocaleTimeString([])}</td>
          <td>${new Date(g.end).toLocaleTimeString([])}</td>
          <td>${g.sample_count}</td>
          <td>${g.electrolytes_pct ?? "\u2014"}</td>
          <td>${g.hydration_pct ?? "\u2014"}</td>
          <td class="${stressClass(stress)}">${stress ?? "\u2014"}</td>
          <td>${g.sodium_meq_l ?? "\u2014"}</td>
          <td>${g.lactate_mmol_l ?? "\u2014"}</td>
          <td>${g.temperature_c ?? "\u2014"}</td>
        </tr>`;
      })
      .join("");
    table.innerHTML = rows || '<tr><td colspan="10" class="seg-hint">No measurements in this session.</td></tr>';
    hint.textContent = data.session.sample_count
      ? `${data.session.sample_count} measurements (within the ${data.mon_window_s}s monitoring window) sliced into ${data.segments.length} segment(s) \u00d7 ${segSec}s`
      : "";
  } catch (e) {
    table.innerHTML = `<tr><td colspan="10">Failed to load segments: ${e.message}</td></tr>`;
  }
}

async function toggleMeasurements(sessionId, button) {
  const wrap = document.getElementById(`meas-${sessionId}`);
  const open = wrap.classList.toggle("open");
  button.textContent = open ? "Hide measurements" : "View all measurements";
  if (!open) return;

  const hint = wrap.querySelector(".seg-hint");
  const table = wrap.querySelector("table");
  try {
    const data = await fetchJSON(`/api/sessions/${sessionId}/measurements`);
    const rows = data
      .map((r) => {
        const stress = r.stress_pct;
        return `<tr>
          <td class="row-seg">${new Date(r.recorded_at).toLocaleString([])}</td>
          <td>${r.electrolytes_pct ?? "\u2014"}</td>
          <td>${r.hydration_pct ?? "\u2014"}</td>
          <td class="${stressClass(stress)}">${stress ?? "\u2014"}</td>
          <td>${r.sodium_meq_l ?? "\u2014"}</td>
          <td>${r.lactate_mmol_l ?? "\u2014"}</td>
          <td>${r.temperature_c ?? "\u2014"}</td>
        </tr>`;
      })
      .join("");
    table.innerHTML = rows || '<tr><td colspan="7" class="seg-hint">No measurements captured in this session.</td></tr>';
    hint.textContent = data.length ? `${data.length} measurement(s) captured during this session` : "";
  } catch (e) {
    table.innerHTML = `<tr><td colspan="7">Failed to load: ${e.message}</td></tr>`;
  }
}

function renderSession(s) {
  const stress = s.stress_pct;
  const card = document.createElement("div");
  card.className = "session";
  card.innerHTML = `
    <div class="session-head">
      <div>
        <div class="session-title">${s.student_name || "Unknown student"} \u00b7 session #${s.id}</div>
        <div class="session-sub">${fmtT(s.started_at)} \u2192 ${fmtT(s.ended_at)} \u00b7 ${fmtDuration(s.started_at, s.ended_at)}</div>
      </div>
      <button class="seg-toggle" data-id="${s.id}">Show segments</button>
    </div>
    <div class="chips">
      ${chip("samples", s.sample_count)}
      ${chip("electrolytes %", s.electrolytes_pct)}
      ${chip("hydration %", s.hydration_pct)}
      ${chip("stress %", s.stress_pct, stressClass(stress))}
      ${chip("sodium mEq/L", s.sodium_meq_l)}
      ${chip("lactate mmol/L", s.lactate_mmol_l)}
      ${chip("temp \u00b0C", s.temperature_c)}
    </div>
    <div class="segments-wrap" id="segs-${s.id}">
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
    <button class="seg-toggle meas-toggle" data-id="${s.id}">View all measurements</button>
    <div class="segments-wrap" id="meas-${s.id}">
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
    </div>`;
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
      op.textContent = `${st.name} (${st.student_code})`;
      studentFilter.appendChild(op);
    }
    if (kept) studentFilter.value = current;

    sessionsCache = sessions;
    render();
  } catch (e) {
    setDbStatus(false);
    sessionsEl.innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
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
load();