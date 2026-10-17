/* Unit tests for the session dashboard helpers - no database required.
   Run: node --test server/test            (or: npm test in server/) */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const history = require("../../api/_history.js");
const lib = require("../../api/_lib.js");

function params(obj) {
  return new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null));
}

/* ── Query parsing / validation ─────────────────────────────────── */

test("parseHistoryQuery applies defaults and offset", () => {
  const { filters, error } = history.parseHistoryQuery(params({}), { defaultOrder: "desc" });
  assert.strictEqual(error, undefined);
  assert.strictEqual(filters.limit, 25);
  assert.strictEqual(filters.page, 1);
  assert.strictEqual(filters.offset, 0);
  assert.strictEqual(filters.order, "desc");
  assert.strictEqual(filters.sort, "recorded_at");
});

test("parseHistoryQuery computes offset from page", () => {
  const { filters } = history.parseHistoryQuery(params({ page: "4", limit: "10" }));
  assert.strictEqual(filters.page, 4);
  assert.strictEqual(filters.limit, 10);
  assert.strictEqual(filters.offset, 30);
});

test("parseHistoryQuery clamps hostile limits", () => {
  assert.strictEqual(history.parseHistoryQuery(params({ limit: "100000" })).filters.limit, 200);
  assert.strictEqual(history.parseHistoryQuery(params({ limit: "-5" })).filters.limit, 1);
  assert.strictEqual(history.parseHistoryQuery(params({ limit: "abc" })).filters.limit, 25);
});

test("parseHistoryQuery rejects invalid enums and dates", () => {
  assert.match(history.parseHistoryQuery(params({ status: "bogus" })).error, /status/);
  assert.match(history.parseHistoryQuery(params({ sort: "drop table" })).error, /sort/);
  assert.match(history.parseHistoryQuery(params({ order: "sideways" })).error, /order/);
  assert.match(history.parseHistoryQuery(params({ student: "10; DROP" })).error, /student/);
  assert.match(history.parseHistoryQuery(params({ from: "not-a-date" })).error, /from/);
  assert.match(history.parseHistoryQuery(params({ from: "2026-02-02", to: "2026-01-01" })).error, /earlier/);
});

test("parseHistoryQuery expands a whole-day date range", () => {
  const { filters } = history.parseHistoryQuery(params({ from: "2026-10-13", to: "2026-10-13" }));
  assert.strictEqual(filters.from.toISOString(), "2026-10-13T00:00:00.000Z");
  assert.strictEqual(filters.to.toISOString(), "2026-10-13T23:59:59.999Z");
});

test("parseHistoryQuery trims and bounds free text", () => {
  const { filters } = history.parseHistoryQuery(params({ q: "  " + "x".repeat(200), source: " " + "y".repeat(80) }));
  assert.strictEqual(filters.search.length, 64);
  assert.strictEqual(filters.source.length, 40);
  assert.strictEqual(history.parseHistoryQuery(params({ q: "   " })).filters.search, "");
});

/* ── Session status ─────────────────────────────────────────────── */

test("sessionStatus derives ACTIVE, COMPLETED and INTERRUPTED", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.strictEqual(lib.sessionStatus("2026-10-13T11:59:00Z", "2026-10-13T11:59:15Z", now), "COMPLETED");
  assert.strictEqual(lib.sessionStatus("2026-10-13T11:59:50Z", null, now), "ACTIVE");
  assert.strictEqual(lib.sessionStatus("2026-10-13T09:00:00Z", null, now), "INTERRUPTED");
});

/* ── CSV ────────────────────────────────────────────────────────── */

test("csvCell distinguishes missing from zero", () => {
  assert.strictEqual(history.csvCell(null, "num"), "");
  assert.strictEqual(history.csvCell(undefined, "text"), "");
  assert.strictEqual(history.csvCell(0, "num"), "0");
  assert.strictEqual(history.csvCell("0.0", "num"), "0.0");
  assert.strictEqual(history.csvCell("", "text"), "");
});

test("csvCell escapes commas, quotes and newlines", () => {
  assert.strictEqual(history.csvCell("a,b", "text"), '"a,b"');
  assert.strictEqual(history.csvCell('say "hi"', "text"), '"say ""hi"""');
  assert.strictEqual(history.csvCell("line1\nline2", "text"), '"line1\nline2"');
  assert.strictEqual(history.csvCell("carriage\rreturn", "text"), '"carriage\rreturn"');
  assert.strictEqual(history.csvCell("plain", "text"), "plain");
});

test("csvCell normalises timestamps to ISO 8601 UTC", () => {
  assert.strictEqual(
    history.csvCell(new Date("2026-10-13T14:00:04.076Z"), "ts"),
    "2026-10-13T14:00:04.076Z"
  );
  assert.strictEqual(history.csvCell("2026-10-13T14:00:04.076Z", "ts"), "2026-10-13T14:00:04.076Z");
  assert.strictEqual(history.csvCell("garbage", "ts"), "");
  assert.strictEqual(history.csvCell(null, "ts"), "");
});

test("recordsToCsv writes a BOM, one header line and one line per record", () => {
  const csv = history.recordsToCsv([
    { id: 1, recorded_at: new Date("2026-10-13T14:00:04.076Z"), source: "mlx90640_thermal", temperature_c: "34.5" },
    { id: 2, recorded_at: new Date("2026-10-13T14:00:06.000Z"), source: "raspberry_pi_camera", electrolytes_pct: "94.0", student_name: "Doe, Jane" },
  ]);
  assert.ok(csv.startsWith("\uFEFF"), "CSV must start with a UTF-8 BOM");
  const lines = csv.slice(1).trim().split("\r\n");
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], history.RECORD_FIELDS.map(f => f.header).join(","));
  assert.ok(lines[0].includes("recorded_at_utc"));
  assert.ok(lines[0].includes("session_id"));
  assert.ok(lines[1].includes("2026-10-13T14:00:04.076Z"));
  assert.ok(lines[1].includes("34.5"));
  assert.ok(lines[2].includes('"Doe, Jane"'), "commas in names are escaped");
  assert.ok(lines[2].includes(",,"), "missing values are empty, never 0");
});

test("every CSV column is distinct and snake_case", () => {
  const headers = history.RECORD_FIELDS.map(f => f.header);
  assert.strictEqual(new Set(headers).size, headers.length);
  for (const header of headers) {
    assert.match(header, /^[a-z0-9_]+$/, header + " must be a sheet-safe column name");
  }
});