/* Project DELTA - session & record reporting (read-only).

   Backs the session dashboard: overview counts, session history, session
   detail (paginated records) and CSV export. Every value shown or exported
   comes straight from PostgreSQL - nothing is generated here.

   Query inputs are validated and bound as parameters; the only values ever
   interpolated into SQL are validated integers (limits, sort direction) and
   the fixed column list.
*/
"use strict";

const { sessionStatus, sessionRecordMatchSql, readingInsideWindowSql, SESSION_FALLBACK_WINDOW_SECONDS, METRIC_VALIDATORS } = require("./_lib.js");

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;
const MAX_EXPORT_ROWS = 100000;
const STATUS_VALUES = ["ACTIVE", "COMPLETED", "INTERRUPTED"];
const RECORD_SORTS = { recorded_at: "m.recorded_at", id: "m.id", source: "m.source" };
const RECORD_SORT_KEYS = Object.keys(RECORD_SORTS);

/* Every stored measurement column, in sheet order. Drives the SQL SELECT
   list, the detail table and the CSV header so they can never drift. */
const RECORD_FIELDS = [
  { column: "id", header: "record_id", type: "int" },
  { column: "recorded_at", header: "recorded_at_utc", type: "ts" },
  { column: "session_client_key", header: "session_id", type: "text" },
  { column: "session_match", header: "session_match", type: "text" },
  { column: "student_code", header: "student_code", type: "int" },
  { column: "student_name", header: "student_name", type: "text" },
  { column: "source", header: "source", type: "text" },
  { column: "temperature_c", header: "temperature_c", type: "num" },
  { column: "electrolytes_pct", header: "electrolytes_pct", type: "num" },
  { column: "electrolyte_confidence", header: "electrolyte_confidence", type: "num" },
  { column: "hydration_pct", header: "hydration_pct", type: "num" },
  { column: "hydration_baseline", header: "hydration_baseline", type: "num" },
  { column: "hydration_confidence", header: "hydration_confidence", type: "num" },
  { column: "stress_pct", header: "stress_pct", type: "num" },
  { column: "sodium_meq_l", header: "sodium_meq_l", type: "num" },
  { column: "lactate_mmol_l", header: "lactate_mmol_l", type: "num" },
  { column: "heart_rate_bpm", header: "heart_rate_bpm", type: "num" },
  { column: "hrv_ms", header: "hrv_ms", type: "num" },
  { column: "breathing_rate", header: "breathing_rate", type: "num" },
  { column: "temperature_baseline", header: "temperature_baseline", type: "num" },
  { column: "temperature_delta", header: "temperature_delta", type: "num" },
  { column: "temperature_confidence", header: "temperature_confidence", type: "num" },
  { column: "measurement_id", header: "measurement_id", type: "text" },
];

const MATCH_COLUMN = "CASE WHEN m.session_client_key IS NULL THEN 'time_window' ELSE 'session_key' END";

/* withSessionJoin: student_name falls back to the session's student so rows
   posted without a name are still attributed in the sheet. */
function recordSelectList(withSessionJoin) {
  const columns = RECORD_FIELDS
    .filter(f => f.column !== "session_match" && f.column !== "student_name")
    .map(f => (f.column === "student_code" ? "s.student_code" : "m." + f.column));
  columns.push(withSessionJoin ? "COALESCE(m.student_name, d.student_name) AS student_name" : "m.student_name");
  return columns.join(", ") + ", " + MATCH_COLUMN + " AS session_match";
}

/* ── Input validation ──────────────────────────────────────────────── */

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function trimTo(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function likePattern(value) {
  return "%" + value.replace(/[\\%_]/g, ch => "\\" + ch) + "%";
}

/* Accepts YYYY-MM-DD (whole day, local-to-UTC bounds) or any ISO timestamp. */
function parseDateInput(value, label) {
  const raw = trimTo(value, 40);
  if (!raw) return { date: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const start = new Date(raw + "T00:00:00.000Z");
    if (Number.isNaN(start.getTime())) return { error: label + " is not a valid date" };
    return { date: start, endDate: new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { error: label + " is not a valid date" };
  return { date: parsed };
}

/* Shared query parsing for session lists, record lists and CSV export.
   Returns { filters } or { error } - callers answer 400 on error. */
function parseHistoryQuery(params, options) {
  const opts = options || {};
  const get = key => (params && typeof params.get === "function" ? params.get(key) : null);

  const from = parseDateInput(get("from"), "from");
  if (from.error) return { error: from.error };
  const to = parseDateInput(get("to"), "to");
  if (to.error) return { error: to.error };
  if (from.date && to.date && to.date < from.date) {
    return { error: "'to' must not be earlier than 'from'" };
  }

  const statusRaw = trimTo(get("status"), 20).toUpperCase();
  if (statusRaw && !STATUS_VALUES.includes(statusRaw)) {
    return { error: "status must be one of " + STATUS_VALUES.join(", ") };
  }

  const orderRaw = trimTo(get("order"), 4).toLowerCase();
  if (orderRaw && orderRaw !== "asc" && orderRaw !== "desc") {
    return { error: "order must be 'asc' or 'desc'" };
  }

  const sortRaw = trimTo(get("sort"), 20);
  if (sortRaw && !RECORD_SORTS[sortRaw]) {
    return { error: "sort must be one of " + RECORD_SORT_KEYS.join(", ") };
  }

  const studentRaw = trimTo(get("student"), 10);
  if (studentRaw && !/^\d{1,10}$/.test(studentRaw)) {
    return { error: "student must be a numeric student code" };
  }

  const limit = clampInt(get("limit"), 1, MAX_LIMIT, DEFAULT_LIMIT);
  const page = clampInt(get("page"), 1, 1000000, 1);

  return {
    filters: {
      limit,
      page,
      offset: (page - 1) * limit,
      search: trimTo(get("q"), 64),
      from: from.date,
      to: to.endDate || to.date || null,
      status: statusRaw,
      order: orderRaw || opts.defaultOrder || "asc",
      sort: sortRaw || opts.defaultSort || "recorded_at",
      source: trimTo(get("source"), 40),
      student: studentRaw || null,
    },
  };
}

/* ── Session history ──────────────────────────────────────────────── */

function sessionStatusFilterSql(status, openMaxAgeMs) {
  if (status === "COMPLETED") return "d.ended_at IS NOT NULL";
  if (status === "ACTIVE") return "d.ended_at IS NULL AND d.started_at > now() - make_interval(secs => " + openMaxAgeMs + ")";
  if (status === "INTERRUPTED") return "d.ended_at IS NULL AND d.started_at <= now() - make_interval(secs => " + openMaxAgeMs + ")";
  return null;
}

function sessionWhereSql(filters, params, openMaxAgeMs) {
  const clauses = [];
  if (filters.search) {
    params.push(likePattern(filters.search));
    const p = "$" + params.length;
    clauses.push("(d.client_key ILIKE " + p + " ESCAPE '\\' OR d.student_name ILIKE " + p
      + " ESCAPE '\\' OR s.student_code::text ILIKE " + p + " ESCAPE '\\')");
  }
  if (filters.from) { params.push(filters.from.toISOString()); clauses.push("d.started_at >= $" + params.length); }
  if (filters.to) { params.push(filters.to.toISOString()); clauses.push("d.started_at <= $" + params.length); }
  if (filters.student) { params.push(Number(filters.student)); clauses.push("s.student_code = $" + params.length); }
  const statusClause = sessionStatusFilterSql(filters.status, openMaxAgeMs);
  if (statusClause) clauses.push(statusClause);
  return clauses.length ? " WHERE " + clauses.join(" AND ") : "";
}

function mapSessionRow(row, nowMs) {
  const startedMs = new Date(row.started_at).getTime();
  const endedMs = row.ended_at ? new Date(row.ended_at).getTime() : null;
  return {
    id: row.id,
    sessionId: row.client_key,
    studentCode: row.student_code != null ? Number(row.student_code) : null,
    studentName: row.student_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: endedMs != null && !Number.isNaN(startedMs) ? endedMs - startedMs : null,
    recordCount: row.record_count || 0,
    firstRecordAt: row.first_record_at,
    lastRecordAt: row.last_record_at,
    status: sessionStatus(row.started_at, row.ended_at, nowMs),
  };
}

async function listSessions(pool, filters, openMaxAgeMs) {
  const countParams = [];
  const where = sessionWhereSql(filters, countParams, openMaxAgeMs);
  const countSql = "SELECT COUNT(*)::int AS n FROM detection_sessions d"
    + " LEFT JOIN students s ON s.id = d.student_id" + where;

  const direction = filters.order === "asc" ? "ASC" : "DESC";
  const params = countParams.slice();
  params.push(filters.limit, filters.offset);
  const sql = "SELECT d.id, d.client_key, d.student_name, d.started_at, d.ended_at, s.student_code, "
    + "a.record_count, a.first_record_at, a.last_record_at "
    + "FROM detection_sessions d "
    + "LEFT JOIN students s ON s.id = d.student_id "
    + "LEFT JOIN LATERAL ("
    + " SELECT COUNT(*)::int AS record_count, MIN(m.recorded_at) AS first_record_at,"
    + " MAX(m.recorded_at) AS last_record_at FROM measurements m WHERE "
    + sessionRecordMatchSql("m", SESSION_FALLBACK_WINDOW_SECONDS)
    + ") a ON true" + where
    + " ORDER BY d.started_at " + direction + " NULLS LAST, d.id " + direction
    + " LIMIT $" + (params.length - 1) + " OFFSET $" + params.length;

  const [count, page] = await Promise.all([pool.query(countSql, countParams), pool.query(sql, params)]);
  const nowMs = Date.now();
  const total = count.rows[0] ? count.rows[0].n : 0;
  return {
    sessions: page.rows.map(row => mapSessionRow(row, nowMs)),
    total,
    page: filters.page,
    limit: filters.limit,
    pages: Math.max(1, Math.ceil(total / filters.limit)),
  };
}

/* ── Records ──────────────────────────────────────────────────────── */

/* scope: a session client key, "unassigned" (no key and outside every
   session window) or "all" (every stored reading). */
function recordsWhereSql(scope, filters, params) {
  const clauses = [];
  if (scope === "unassigned") {
    clauses.push("m.session_client_key IS NULL AND NOT EXISTS ("
      + "SELECT 1 FROM detection_sessions d2 WHERE "
      + readingInsideWindowSql("m", "d2", SESSION_FALLBACK_WINDOW_SECONDS) + ")");
  } else if (scope !== "all") {
    params.push(String(scope).slice(0, 64));
    clauses.push("d.client_key = $" + params.length);
  }
  if (filters.source) { params.push(filters.source); clauses.push("m.source = $" + params.length); }
  if (filters.from) { params.push(filters.from.toISOString()); clauses.push("m.recorded_at >= $" + params.length); }
  if (filters.to) { params.push(filters.to.toISOString()); clauses.push("m.recorded_at <= $" + params.length); }

  const from = scope === "all" || scope === "unassigned"
    ? " FROM measurements m LEFT JOIN students s ON s.id = m.student_id"
    : " FROM detection_sessions d"
      + " JOIN measurements m ON " + sessionRecordMatchSql("m", SESSION_FALLBACK_WINDOW_SECONDS)
      + " LEFT JOIN students s ON s.id = m.student_id";

  return {
    from,
    where: clauses.length ? " WHERE " + clauses.join(" AND ") : "",
    selectList: recordSelectList(scope !== "all" && scope !== "unassigned"),
  };
}

function orderClause(filters) {
  const column = RECORD_SORTS[filters.sort] || RECORD_SORTS.recorded_at;
  const direction = filters.order === "desc" ? "DESC" : "ASC";
  return " ORDER BY " + column + " " + direction + ", m.id " + direction;
}

function mapRecordRow(row) {
  const out = {};
  for (const field of RECORD_FIELDS) {
    out[field.column] = row[field.column] === undefined ? null : row[field.column];
  }
  return out;
}

/* Min/average/max per stored metric over the whole filtered set (not just
   the current page), so the detail header never describes a subset. */
async function recordSummary(pool, parts, params) {
  const selects = [];
  for (const [metric, def] of Object.entries(METRIC_VALIDATORS)) {
    const column = "m." + def.column;
    selects.push("MIN(" + column + ") AS " + metric + "__min");
    selects.push("AVG(" + column + ") AS " + metric + "__avg");
    selects.push("MAX(" + column + ") AS " + metric + "__max");
    selects.push("COUNT(" + column + ") AS " + metric + "__count");
  }
  const { rows } = await pool.query("SELECT " + selects.join(", ") + parts.from + parts.where, params);
  const row = rows[0] || {};
  const summary = {};
  for (const [metric, def] of Object.entries(METRIC_VALIDATORS)) {
    const count = Number(row[metric + "__count"] || 0);
    if (count === 0) continue;
    const round = value => (value == null ? null : Number(Number(value).toFixed(2)));
    summary[metric] = {
      min: round(row[metric + "__min"]),
      avg: round(row[metric + "__avg"]),
      max: round(row[metric + "__max"]),
      count,
      unit: def.unit,
    };
  }
  return summary;
}

/* Distinct sources available for this scope, independent of the source
   filter itself so the filter list never loses an option. */
async function recordSources(pool, scope) {
  const params = [];
  const parts = recordsWhereSql(scope, {}, params);
  const and = parts.where ? parts.where + " AND" : "WHERE";
  const { rows } = await pool.query(
    "SELECT DISTINCT m.source" + parts.from + " " + and + " m.source IS NOT NULL ORDER BY m.source",
    params
  );
  return rows.map(r => r.source);
}

async function listRecords(pool, scope, filters) {
  const params = [];
  const parts = recordsWhereSql(scope, filters, params);
  const countSql = "SELECT COUNT(*)::int AS n" + parts.from + parts.where;

  const pageParams = params.slice();
  pageParams.push(filters.limit, filters.offset);
  const sql = "SELECT " + parts.selectList + parts.from + parts.where + orderClause(filters)
    + " LIMIT $" + (pageParams.length - 1) + " OFFSET $" + pageParams.length;

  const [count, rows, summary, sources] = await Promise.all([
    pool.query(countSql, params),
    pool.query(sql, pageParams),
    recordSummary(pool, parts, params),
    recordSources(pool, scope),
  ]);
  const total = count.rows[0] ? count.rows[0].n : 0;
  return {
    records: rows.rows.map(mapRecordRow),
    summary,
    sources,
    total,
    page: filters.page,
    limit: filters.limit,
    pages: Math.max(1, Math.ceil(total / filters.limit)),
  };
}

/* ── Overview ─────────────────────────────────────────────────────── */

const LATEST_SESSION_SQL = "SELECT d.id, d.client_key, d.student_name, d.started_at, d.ended_at,"
  + " s.student_code, a.record_count, a.first_record_at, a.last_record_at "
  + "FROM detection_sessions d "
  + "LEFT JOIN students s ON s.id = d.student_id "
  + "LEFT JOIN LATERAL ("
  + " SELECT COUNT(*)::int AS record_count, MIN(m.recorded_at) AS first_record_at,"
  + " MAX(m.recorded_at) AS last_record_at FROM measurements m WHERE "
  + sessionRecordMatchSql("m", SESSION_FALLBACK_WINDOW_SECONDS)
  + ") a ON true";

async function getStats(pool, openMaxAgeMs) {
  const { rows } = await pool.query(
    "SELECT "
    + "(SELECT COUNT(*)::int FROM detection_sessions) AS total_sessions,"
    + "(SELECT COUNT(*)::int FROM measurements) AS total_records,"
    + "(SELECT COUNT(*)::int FROM measurements WHERE session_client_key IS NOT NULL) AS linked_records,"
    + "(SELECT COUNT(*)::int FROM students) AS total_students,"
    + "(SELECT MIN(started_at) FROM detection_sessions) AS first_session_at,"
    + "(SELECT MAX(started_at) FROM detection_sessions) AS last_session_at,"
    + "(SELECT MIN(recorded_at) FROM measurements) AS first_record_at,"
    + "(SELECT MAX(recorded_at) FROM measurements) AS last_record_at,"
    + "(SELECT COUNT(*)::int FROM detection_sessions WHERE ended_at IS NULL"
    + " AND started_at > now() - make_interval(secs => " + openMaxAgeMs + ")) AS active_sessions,"
    + "(SELECT COUNT(*)::int FROM detection_sessions WHERE ended_at IS NULL"
    + " AND started_at <= now() - make_interval(secs => " + openMaxAgeMs + ")) AS interrupted_sessions"
  );
  const stats = rows[0];
  const latest = await pool.query(LATEST_SESSION_SQL + " ORDER BY d.started_at DESC LIMIT 1");
  const nowMs = Date.now();
  return {
    totalSessions: stats.total_sessions,
    totalRecords: stats.total_records,
    linkedRecords: stats.linked_records,
    unlinkedRecords: stats.total_records - stats.linked_records,
    totalStudents: stats.total_students,
    activeSessions: stats.active_sessions,
    interruptedSessions: stats.interrupted_sessions,
    completedSessions: stats.total_sessions - stats.active_sessions - stats.interrupted_sessions,
    firstSessionAt: stats.first_session_at,
    lastSessionAt: stats.last_session_at,
    firstRecordAt: stats.first_record_at,
    lastRecordAt: stats.last_record_at,
    latestSession: latest.rows.length ? mapSessionRow(latest.rows[0], nowMs) : null,
  };
}

/* ── CSV export ───────────────────────────────────────────────────── */

function isoTimestamp(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/* RFC 4180: wrap in quotes when the value holds a comma, quote, CR or LF. */
function csvCell(value, type) {
  if (value === null || value === undefined) return "";
  const text = type === "ts" ? isoTimestamp(value) : String(value);
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/* UTF-8 BOM keeps spreadsheet apps on the right encoding. */
function recordsToCsv(records) {
  const lines = [RECORD_FIELDS.map(f => f.header).join(",")];
  for (const record of records) {
    lines.push(RECORD_FIELDS.map(f => csvCell(record[f.column], f.type)).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

async function exportRecordsCsv(pool, scope, filters) {
  const params = [];
  const parts = recordsWhereSql(scope, filters, params);
  const { rows } = await pool.query(
    "SELECT " + parts.selectList + parts.from + parts.where + orderClause(filters)
    + " LIMIT " + (MAX_EXPORT_ROWS + 1),
    params
  );
  const truncated = rows.length > MAX_EXPORT_ROWS;
  const records = (truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows).map(mapRecordRow);
  return { csv: recordsToCsv(records), rowCount: records.length, truncated };
}

module.exports = {
  RECORD_FIELDS,
  MAX_EXPORT_ROWS,
  parseHistoryQuery,
  listSessions,
  listRecords,
  recordsWhereSql,
  getStats,
  csvCell,
  recordsToCsv,
  exportRecordsCsv,
};