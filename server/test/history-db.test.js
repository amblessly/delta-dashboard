/* Database integration tests for session persistence and reporting.

   Hardware-independent: everything here runs against the configured
   PostgreSQL database through the same code path the live server uses.

   The tests only ever create and delete rows carrying the TEST_KEY prefix,
   so real collected data is never touched.

   Run: npm run test:db   (from server/)
*/
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? test : test.skip;

if (!DATABASE_URL) {
  console.error("[test:db] DATABASE_URL missing (server/.env) - database tests skipped.");
}

const { Pool } = require("pg");
const lib = require("../../api/_lib.js");
const history = require("../../api/_history.js");

const TEST_KEY = "selftest-" + Date.now().toString(36);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on("error", () => {});

const filters = extra => history.parseHistoryQuery(new URLSearchParams(extra || {})).filters;

async function cleanup() {
  /* Only rows this file created: the session keys carry TEST_KEY, the
     readings carry a selftest* source. Collected data is never touched. */
  await pool.query(
    "DELETE FROM measurements WHERE session_client_key LIKE $1 OR source LIKE $2",
    [TEST_KEY + "%", "selftest%"]
  );
  await pool.query("DELETE FROM detection_sessions WHERE client_key LIKE $1", [TEST_KEY + "%"]);
}

test.after(async () => {
  await cleanup();
  await pool.end();
});

describeDb("a recorded session is stored, linked and reported", async t => {
  const studentCode = 101;
  const sessionKey = TEST_KEY + "-a";

  await t.test("ingest links a reading to the running session without a session key", async () => {
    const started = await lib.startSession(pool, { clientKey: sessionKey, studentCode });
    assert.strictEqual(started.ok, true);

    /* Same payload shape the Raspberry Pi services post: no session key. */
    const reading = await lib.insertMeasurement(pool, {
      studentCode,
      source: "selftest_sensor",
      recordedAt: new Date().toISOString(),
      metrics: { temperature: 34.5, sodium: 138, electrolytes: 90 },
    });
    assert.strictEqual(reading.ok, true, JSON.stringify(reading));
    assert.strictEqual(reading.sessionClientKey, sessionKey, "reading must attach to the open session");
  });

  await t.test("a repeated measurementId is stored once", async () => {
    const body = {
      studentCode,
      source: "selftest_sensor",
      measurementId: TEST_KEY + "-dedupe",
      metrics: { lactate: 1.5 },
    };
    const first = await lib.insertMeasurement(pool, body);
    const second = await lib.insertMeasurement(pool, body);
    assert.notStrictEqual(first.duplicate, true);
    assert.strictEqual(second.duplicate, true, "same measurementId must not create a second row");
    assert.strictEqual(first.id, second.id);
  });

  await t.test("an out-of-range reading is rejected, not coerced", async () => {
    const bad = await lib.insertMeasurement(pool, {
      studentCode, source: "selftest_sensor", metrics: { temperature: 900 },
    });
    assert.ok(bad.error, "temperature=900 must be rejected");
    const good = await lib.insertMeasurement(pool, {
      studentCode, source: "selftest_sensor", metrics: { hydration: 0 },
    });
    assert.strictEqual(good.ok, true, "0 is a valid reading and must not be treated as missing");
  });

  await t.test("the session is reported with its record count", async () => {
    const page = await history.listSessions(pool, filters({ q: sessionKey, limit: "10" }), 7200);
    assert.strictEqual(page.total, 1);
    const session = page.sessions[0];
    assert.strictEqual(session.sessionId, sessionKey);
    assert.strictEqual(session.studentCode, studentCode);
    assert.strictEqual(session.status, "ACTIVE");
    assert.ok(session.recordCount >= 3, "expected the test readings, got " + session.recordCount);
    assert.strictEqual(session.endedAt, null);
  });

  await t.test("session detail lists only that session's records", async () => {
    const records = await history.listRecords(pool, sessionKey, filters({ limit: "50" }));
    assert.ok(records.total >= 3);
    for (const record of records.records) {
      assert.strictEqual(record.session_client_key, sessionKey);
      assert.strictEqual(record.session_match, "session_key");
      assert.strictEqual(Number(record.student_code), studentCode);
    }
    const ordered = records.records.map(r => new Date(r.recorded_at).getTime());
    assert.deepStrictEqual(ordered, [...ordered].sort((a, b) => a - b), "records default to ascending time");
  });

  await t.test("record filtering by source and paging are correct", async () => {
    const all = await history.listRecords(pool, sessionKey, filters({ limit: "50" }));
    const bySource = await history.listRecords(pool, sessionKey, filters({ source: "selftest_sensor" }));
    assert.strictEqual(bySource.total, all.total);
    const unknownSource = await history.listRecords(pool, sessionKey, filters({ source: "no_such_sensor" }));
    assert.strictEqual(unknownSource.total, 0);
    assert.deepStrictEqual(unknownSource.records, []);

    const first = await history.listRecords(pool, sessionKey, filters({ limit: "1", page: "1" }));
    const second = await history.listRecords(pool, sessionKey, filters({ limit: "1", page: "2" }));
    const newest = await history.listRecords(pool, sessionKey, filters({ limit: "1", order: "desc" }));
    assert.strictEqual(first.records.length, 1);
    assert.strictEqual(first.records[0].id, all.records[0].id);
    assert.strictEqual(second.records[0].id, all.records[1].id);
    assert.strictEqual(newest.records[0].id, all.records[all.records.length - 1].id);
  });

  await t.test("CSV export contains this session's records and nothing else", async () => {
    const exported = await history.exportRecordsCsv(pool, sessionKey, filters({}));
    const lines = exported.csv.slice(1).trim().split("\r\n");
    assert.strictEqual(lines.length, exported.rowCount + 1, "header + one line per record");
    for (const line of lines.slice(1)) {
      assert.ok(line.includes(sessionKey), "every exported line belongs to the exported session");
    }
    assert.ok(!exported.csv.includes("recorded_at_utc,record_id"), "header order comes from RECORD_FIELDS");
    assert.ok(exported.csv.includes("session_id"), "header must carry a session_id column");
  });

  await t.test("ending the session marks it complete", async () => {
    const ended = await lib.endSession(pool, sessionKey);
    assert.strictEqual(ended.updated, 1);
    const page = await history.listSessions(pool, filters({ q: sessionKey }), 7200);
    assert.strictEqual(page.sessions[0].status, "COMPLETED");
    assert.ok(page.sessions[0].endedAt, "endedAt is stored");
    assert.ok(page.sessions[0].durationMs >= 0);
  });
});

describeDb("sessions stay independent", async t => {
  const a = TEST_KEY + "-one";
  const b = TEST_KEY + "-two";

  await t.test("two sessions keep their own records", async () => {
    await lib.startSession(pool, { clientKey: a, studentCode: 101 });
    await lib.insertMeasurement(pool, { studentCode: 101, source: "selftest_a", metrics: { temperature: 30.1 } });
    await lib.endSession(pool, a);

    await lib.startSession(pool, { clientKey: b, studentCode: 101 });
    await lib.insertMeasurement(pool, { studentCode: 101, source: "selftest_b", metrics: { temperature: 31.2 } });
    await lib.endSession(pool, b);

    const recA = await history.listRecords(pool, a, filters({}));
    const recB = await history.listRecords(pool, b, filters({}));
    assert.strictEqual(recA.total, 1);
    assert.strictEqual(recB.total, 1);
    assert.strictEqual(recA.records[0].source, "selftest_a");
    assert.strictEqual(recB.records[0].source, "selftest_b");
    assert.notStrictEqual(recA.records[0].recorded_at, recB.records[0].recorded_at);
  });

  await t.test("an empty session is reported with zero records", async () => {
    const empty = TEST_KEY + "-empty";
    await lib.startSession(pool, { clientKey: empty, studentCode: 101 });
    await lib.endSession(pool, empty);
    const page = await history.listSessions(pool, filters({ q: empty }), 7200);
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.sessions[0].recordCount, 0);
    const records = await history.listRecords(pool, empty, filters({}));
    assert.strictEqual(records.total, 0);
    assert.deepStrictEqual(records.records, []);
    const exported = await history.exportRecordsCsv(pool, empty, filters({}));
    assert.strictEqual(exported.rowCount, 0);
    assert.strictEqual(exported.csv.trim().split("\r\n").length, 1, "header only");
  });

  await t.test("history survives a fresh connection to the database", async () => {
    const other = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const found = await other.query("SELECT client_key FROM detection_sessions WHERE client_key = $1", [a]);
      assert.strictEqual(found.rowCount, 1);
    } finally {
      await other.end();
    }
  });
});

describeDb("readings are attributed by session window when no key is stored", async t => {
  await t.test("a keyed reading and a window reading both appear in the session", async () => {
    const key = TEST_KEY + "-window";
    await lib.startSession(pool, { clientKey: key, studentCode: 101 });
    await lib.insertMeasurement(pool, { studentCode: 101, source: "selftest_keyed", metrics: { temperature: 32.0 } });
    await lib.endSession(pool, key);

    /* Rows posted by a sensor that predates session keys: no session key,
       recorded inside the session window (halfway between start and end). */
    await pool.query(
      "INSERT INTO measurements (student_id, source, temperature_c, recorded_at) "
      + "SELECT s.id, 'selftest_legacy', 33.3, d.started_at + (d.ended_at - d.started_at) / 2 "
      + "FROM students s, detection_sessions d WHERE s.student_code = 101 AND d.client_key = $1",
      [key]
    );

    const records = await history.listRecords(pool, key, filters({}));
    const bySource = Object.fromEntries(records.records.map(r => [r.source, r.session_match]));
    assert.strictEqual(bySource.selftest_keyed, "session_key");
    assert.strictEqual(bySource.selftest_legacy, "time_window");

    const exported = await history.exportRecordsCsv(pool, key, filters({}));
    assert.ok(exported.csv.includes("time_window"), "CSV states how the row was matched");
  });

  await t.test("the all-records export includes every stored reading", async () => {
    const exported = await history.exportRecordsCsv(pool, "all", filters({}));
    const total = await pool.query("SELECT COUNT(*)::int AS n FROM measurements");
    assert.strictEqual(exported.rowCount, Math.min(total.rows[0].n, history.MAX_EXPORT_ROWS));
    assert.strictEqual(exported.truncated, total.rows[0].n > history.MAX_EXPORT_ROWS);
  });
});

describeDb("overview counts come from the database", async t => {
  await t.test("stats are consistent with the underlying tables", async () => {
    const stats = await history.getStats(pool, 7200);
    const sessions = await pool.query("SELECT COUNT(*)::int AS n FROM detection_sessions");
    const records = await pool.query("SELECT COUNT(*)::int AS n FROM measurements");
    const students = await pool.query("SELECT COUNT(*)::int AS n FROM students");
    assert.strictEqual(stats.totalSessions, sessions.rows[0].n);
    assert.strictEqual(stats.totalRecords, records.rows[0].n);
    assert.strictEqual(stats.totalStudents, students.rows[0].n);
    assert.strictEqual(stats.linkedRecords + stats.unlinkedRecords, stats.totalRecords);
    assert.strictEqual(
      stats.completedSessions + stats.activeSessions + stats.interruptedSessions,
      stats.totalSessions
    );
    if (stats.latestSession) assert.ok(stats.latestSession.recordCount >= 0);
  });
});

describeDb("database failures surface as errors", async t => {
  await t.test("an invalid query rejects instead of returning silent data", async () => {
    const broken = {
      query() { return Promise.reject(new Error("simulated database outage")); },
    };
    await assert.rejects(() => history.listSessions(broken, filters({}), 7200), /simulated database outage/);
    await assert.rejects(() => history.listRecords(broken, TEST_KEY + "-a", filters({})), /simulated database outage/);
    await assert.rejects(() => history.getStats(broken, 7200), /simulated database outage/);
    await assert.rejects(() => history.exportRecordsCsv(broken, "all", filters({})), /simulated database outage/);
  });

  await t.test("a reading for an unknown student is rejected", async () => {
    const result = await lib.insertMeasurement(pool, { studentCode: 999999, source: "selftest", metrics: { temperature: 34 } });
    assert.match(result.error, /studentCode/);
  });
});