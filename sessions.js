"use strict";

/* sessions.js - Project DELTA session data website.

   Read-only view of the PostgreSQL database served by server/server.js:
   overview counts, session history, session detail and CSV export.
   Every value comes from the API; nothing is generated client-side. */

const el = id => document.getElementById(id);

const state = {
  sessions: { q: "", from: "", to: "", status: "", limit: "25", page: 1, order: "desc" },
  records: { source: "", from: "", to: "", sort: "recorded_at", order: "asc", limit: "50", page: 1 },
  openKey: null,
  openSession: null,
  columns: [],
  showAll: false,
};

/* Columns shown before "show every stored column" is ticked. */
const PRIMARY_COLUMNS = [
  "recorded_at", "source", "temperature_c", "electrolytes_pct",
  "sodium_meq_l", "lactate_mmol_l", "hydration_pct", "stress_pct",
];

const COLUMN_TITLES = {
  recorded_at: "Recorded at (device time)",
  session_client_key: "Session id stored with the reading",
  session_match: "How the reading was matched to this session",
  student_code: "Student ID",
  student_name: "Student name",
  source: "Sensor service that produced the reading",
  temperature_c: "Skin temperature, MLX90640 (°C)",
  electrolytes_pct: "Electrolyte index from the test strip (%)",
  electrolyte_confidence: "Electrolyte confidence 0-1",
  hydration_pct: "Hydration (%)",
  hydration_baseline: "Hydration baseline (%)",
  hydration_confidence: "Hydration confidence 0-1",
  stress_pct: "Stress (%)",
  sodium_meq_l: "Sodium (mEq/L)",
  lactate_mmol_l: "Lactate (mmol/L)",
  heart_rate_bpm: "Heart rate (bpm)",
  hrv_ms: "Heart rate variability (ms)",
  breathing_rate: "Breathing rate (/min)",
  temperature_baseline: "Temperature baseline (°C)",
  temperature_delta: "Temperature above baseline (°C)",
  temperature_confidence: "Temperature confidence 0-1",
  measurement_id: "Reading id used for duplicate protection",
  id: "Database row id",
};

/* ── Helpers ─────────────────────────────────────────────────── */

function queryString(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === "" || value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

async function api(path, filters) {
  const qs = filters ? queryString(filters) : "";
  const res = await fetch(path + (qs ? "?" + qs : ""), { headers: { Accept: "application/json" } });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
  return data;
}

function formatTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(n);
}

function setStateBox(node, message, kind) {
  if (!message) { node.hidden = true; node.textContent = ""; node.className = "state"; return; }
  node.hidden = false;
  node.textContent = message;
  node.className = "state" + (kind ? " " + kind : "");
}

function showError(message) {
  el("errorText").textContent = message;
  el("errorBanner").hidden = false;
}

function clearError() {
  el("errorBanner").hidden = true;
}

function setDbState(text, kind) {
  const node = el("dbState");
  node.textContent = text;
  node.className = "db-state mono" + (kind ? " " + kind : "");
}

/* ── Overview ───────────────────────────────────────────────── */

async function loadStats() {
  const stats = await api("/api/stats");
  el("statSessions").textContent = stats.totalSessions;
  el("statRecords").textContent = stats.totalRecords;
  el("statLinked").textContent = stats.linkedRecords + " / " + stats.totalRecords;
  el("statActive").textContent = stats.activeSessions;
  if (stats.latestSession) {
    el("statLatest").textContent = formatTime(stats.latestSession.startedAt) || "--";
    el("statLatestNote").textContent =
      stats.latestSession.sessionId + " · " + stats.latestSession.status.toLowerCase()
      + " · " + stats.latestSession.recordCount + " records";
  } else {
    el("statLatest").textContent = "no sessions";
    el("statLatestNote").textContent = "";
  }
  const range = [stats.firstRecordAt, stats.lastRecordAt].filter(Boolean).map(formatTime).filter(Boolean);
  el("statRange").textContent = range.length ? range[0] + "  →  " + range[range.length - 1] : "--";
  setDbState("DATABASE CONNECTED", "ok");
}

/* ── Session history ────────────────────────────────────────── */

function readSessionFilters() {
  state.sessions = {
    q: el("filterQ").value.trim(),
    from: el("filterFrom").value,
    to: el("filterTo").value,
    status: el("filterStatus").value,
    limit: el("sessionLimit").value,
    page: 1,
    order: "desc",
  };
}

async function loadSessions() {
  const tbody = el("sessionRows");
  setStateBox(el("sessionState"), "Loading sessions...");
  tbody.innerHTML = "";
  try {
    const data = await api("/api/sessions", state.sessions);
    renderSessions(data);
    clearError();
    setDbState("DATABASE CONNECTED", "ok");
  } catch (e) {
    setStateBox(el("sessionState"), "Could not load sessions: " + e.message, "error");
    showError("Session list failed: " + e.message);
  }
}

function sessionRow(session) {
  const tr = document.createElement("tr");

  const id = document.createElement("td");
  id.className = "key";
  id.textContent = session.sessionId;
  id.title = session.sessionId;
  tr.appendChild(id);

  const student = document.createElement("td");
  student.textContent = session.studentCode != null
    ? "ID " + session.studentCode + (session.studentName ? " · " + session.studentName : "")
    : (session.studentName || "—");
  tr.appendChild(student);

  tr.appendChild(timeCell(session.startedAt, session.startedAt));
  tr.appendChild(timeCell(session.endedAt, session.endedAt ? session.endedAt + " (not closed)" : "still open"));

  const duration = document.createElement("td");
  const durationText = formatDuration(session.durationMs);
  duration.textContent = durationText || "—";
  if (!durationText) duration.className = "missing";
  tr.appendChild(duration);

  const records = document.createElement("td");
  records.className = "num";
  records.textContent = session.recordCount;
  if (session.recordCount === 0) records.className = "num missing";
  tr.appendChild(records);

  const status = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = "pill " + session.status.toLowerCase();
  pill.textContent = session.status;
  status.appendChild(pill);
  tr.appendChild(status);

  const actions = document.createElement("td");
  const view = document.createElement("button");
  view.type = "button";
  view.className = "btn small";
  view.textContent = "VIEW";
  view.addEventListener("click", () => openSession(session));
  actions.appendChild(view);
  const csv = document.createElement("a");
  csv.className = "btn small ghost";
  csv.style.marginLeft = "6px";
  csv.textContent = "CSV";
  csv.href = "/api/sessions/" + encodeURIComponent(session.sessionId) + "/export.csv";
  csv.setAttribute("download", "");
  actions.appendChild(csv);
  tr.appendChild(actions);

  return tr;
}

function timeCell(value, title) {
  const td = document.createElement("td");
  const text = formatTime(value);
  td.textContent = text || "—";
  if (!text) td.className = "missing";
  if (title) td.title = title;
  return td;
}

function renderSessions(data) {
  const tbody = el("sessionRows");
  tbody.innerHTML = "";
  if (!data.sessions.length) {
    setStateBox(el("sessionState"), data.total === 0
      ? "No sessions recorded yet. Start one from the terminal (http://<pi>:8000)."
      : "No sessions match these filters.");
    el("sessionPageInfo").textContent = "";
    el("sessionPrev").disabled = true;
    el("sessionNext").disabled = true;
    return;
  }
  setStateBox(el("sessionState"), null);
  for (const session of data.sessions) tbody.appendChild(sessionRow(session));

  const first = (data.page - 1) * data.limit + 1;
  const last = Math.min(data.page * data.limit, data.total);
  el("sessionPageInfo").textContent =
    first + "–" + last + " of " + data.total + " · page " + data.page + " of " + data.pages;
  el("sessionPrev").disabled = data.page <= 1;
  el("sessionNext").disabled = data.page >= data.pages;
  el("exportAllBtn").href = "/api/sessions/all/export.csv?"
    + queryString({ from: state.sessions.from, to: state.sessions.to });
}

/* ── Session detail ─────────────────────────────────────────── */

async function openSession(session) {
  state.openKey = session.sessionId;
  state.openSession = session;
  state.records.page = 1;
  location.hash = "session=" + encodeURIComponent(session.sessionId);
  el("detailPanel").hidden = false;
  renderDetailMeta(session);
  await loadRecords();
  el("detailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeSession() {
  state.openKey = null;
  state.openSession = null;
  el("detailPanel").hidden = true;
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

function metaBlock(key, value) {
  const wrap = document.createElement("div");
  const k = document.createElement("span");
  k.className = "meta-key mono";
  k.textContent = key;
  const v = document.createElement("span");
  v.className = "meta-value";
  v.textContent = value == null || value === "" ? "—" : String(value);
  if (value == null || value === "") v.className = "meta-value missing";
  wrap.appendChild(k);
  wrap.appendChild(v);
  return wrap;
}

function renderDetailMeta(session) {
  const meta = el("detailMeta");
  meta.innerHTML = "";
  meta.appendChild(metaBlock("Session id", session.sessionId));
  meta.appendChild(metaBlock("Student", session.studentCode != null
    ? "ID " + session.studentCode + (session.studentName ? " · " + session.studentName : "")
    : session.studentName));
  meta.appendChild(metaBlock("Started", formatTime(session.startedAt)));
  meta.appendChild(metaBlock("Ended", formatTime(session.endedAt)));
  meta.appendChild(metaBlock("Duration", formatDuration(session.durationMs)));
  meta.appendChild(metaBlock("Status", session.status));
  meta.appendChild(metaBlock("Records in session", session.recordCount));
  meta.appendChild(metaBlock("First record", formatTime(session.firstRecordAt)));
  meta.appendChild(metaBlock("Last record", formatTime(session.lastRecordAt)));
}

function renderSummary(summary) {
  const box = el("detailSummary");
  box.innerHTML = "";
  const entries = Object.entries(summary || {});
  if (!entries.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const [metric, stats] of entries) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = metric.toUpperCase()
      + " min <b>" + stats.min + "</b> avg <b>" + stats.avg + "</b> max <b>" + stats.max + "</b>"
      + " " + stats.unit + " · n=" + stats.count;
    box.appendChild(chip);
  }
}

async function loadRecords() {
  if (!state.openKey) return;
  const tbody = el("recordRows");
  setStateBox(el("recordState"), "Loading records...");
  tbody.innerHTML = "";
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(state.openKey) + "/records", state.records);
    renderRecords(data);
    renderSummary(data.summary);
    clearError();
    setDbState("DATABASE CONNECTED", "ok");
  } catch (e) {
    setStateBox(el("recordState"), "Could not load records: " + e.message, "error");
    showError("Session records failed: " + e.message);
  }
}

function visibleColumns() {
  if (state.showAll || !state.columns.length) return state.columns;
  return state.columns.filter(c => PRIMARY_COLUMNS.includes(c));
}

function renderRecords(data) {
  const head = el("recordHead");
  const tbody = el("recordRows");
  head.innerHTML = "";
  tbody.innerHTML = "";

  if (data.records.length) {
    state.columns = Object.keys(data.records[0]);
  }
  fillSourceOptions(data.sources);

  const columns = visibleColumns();
  if (!columns.length) {
    setStateBox(el("recordState"), "No records to show.");
    el("recordPageInfo").textContent = "";
    el("recordPrev").disabled = true;
    el("recordNext").disabled = true;
    return;
  }

  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column;
    if (COLUMN_TITLES[column]) th.title = COLUMN_TITLES[column];
    head.appendChild(th);
  }

  for (const record of data.records) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      const raw = record[column];
      if (raw === null || raw === undefined || raw === "") {
        td.textContent = "—";           /* missing, deliberately not 0 */
        td.className = "missing";
        td.title = "not recorded";
      } else if (column === "recorded_at") {
        td.textContent = formatTime(raw);
        td.title = raw;
      } else if (column === "id" || column === "session_client_key" || column === "measurement_id") {
        td.textContent = raw;
        td.className = "key";
      } else {
        td.textContent = formatNumber(raw);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  if (!data.total) {
    setStateBox(el("recordState"), "This session has no recorded data.");
  } else {
    setStateBox(el("recordState"), null);
  }

  const first = (data.page - 1) * data.limit + 1;
  const last = Math.min(data.page * data.limit, data.total);
  el("recordPageInfo").textContent =
    first + "–" + last + " of " + data.total + " · page " + data.page + " of " + data.pages;
  el("recordPrev").disabled = data.page <= 1;
  el("recordNext").disabled = data.page >= data.pages;
  el("detailExport").onclick = () => {
    location.href = "/api/sessions/" + encodeURIComponent(state.openKey) + "/export.csv?"
      + queryString({ source: state.records.source, from: state.records.from, to: state.records.to,
        sort: state.records.sort, order: state.records.order });
  };
}

function fillSourceOptions(sources) {
  const select = el("recordSource");
  const current = select.value;
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All sources";
  select.appendChild(all);
  for (const value of sources || []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = sources && sources.includes(current) ? current : "";
  state.records.source = select.value;
}

/* ── Wiring ─────────────────────────────────────────────────── */

el("sessionFilters").addEventListener("submit", event => {
  event.preventDefault();
  readSessionFilters();
  loadSessions();
});

el("sessionReset").addEventListener("click", () => {
  setTimeout(() => {
    readSessionFilters();
    loadSessions();
  }, 0);
});

el("sessionPrev").addEventListener("click", () => {
  if (state.sessions.page > 1) { state.sessions.page -= 1; loadSessions(); }
});
el("sessionNext").addEventListener("click", () => { state.sessions.page += 1; loadSessions(); });

el("recordFilters").addEventListener("submit", event => {
  event.preventDefault();
  state.records.source = el("recordSource").value;
  state.records.from = el("recordFrom").value;
  state.records.to = el("recordTo").value;
  state.records.sort = el("recordSort").value;
  state.records.order = el("recordOrder").value;
  state.records.limit = el("recordLimit").value;
  state.records.page = 1;
  loadRecords();
});

el("recordReset").addEventListener("click", () => {
  setTimeout(() => {
    state.records.source = "";
    state.records.from = "";
    state.records.to = "";
    state.records.sort = "recorded_at";
    state.records.order = "asc";
    state.records.limit = "50";
    state.records.page = 1;
    loadRecords();
  }, 0);
});

el("recordPrev").addEventListener("click", () => {
  if (state.records.page > 1) { state.records.page -= 1; loadRecords(); }
});
el("recordNext").addEventListener("click", () => { state.records.page += 1; loadRecords(); });
el("detailClose").addEventListener("click", closeSession);
el("allColumns").addEventListener("change", event => {
  state.showAll = event.target.checked;
  if (state.openKey) loadRecords();
});

el("exportAllBtn").title = "Downloads every stored reading as CSV";
el("refreshBtn").addEventListener("click", () => {
  loadStats().catch(e => showError("Overview failed: " + e.message));
  loadSessions();
  if (state.openKey) loadRecords();
});
el("errorRetry").addEventListener("click", () => el("refreshBtn").click());

window.addEventListener("hashchange", () => {
  const key = decodeURIComponent((location.hash.match(/session=([^&]+)/) || [])[1] || "");
  if (key && key !== state.openKey) restoreSession(key);
});

async function restoreSession(key) {
  try {
    const data = await api("/api/sessions", { q: key, limit: "25" });
    const session = data.sessions.find(s => s.sessionId === key);
    if (session) await openSession(session);
    else closeSession();
  } catch (e) {
    closeSession();
    showError("Could not open session " + key + ": " + e.message);
  }
}

async function bootstrap() {
  setDbState("CONNECTING");
  try {
    await loadStats();
  } catch (e) {
    setDbState("DATABASE OFFLINE", "bad");
    showError("Overview failed: " + e.message);
  }
  await loadSessions();

  const key = decodeURIComponent((location.hash.match(/session=([^&]+)/) || [])[1] || "");
  if (key) await restoreSession(key);
}

bootstrap();