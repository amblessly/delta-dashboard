/* Project DELTA shared backend library.
   Used by BOTH api/*.js (Vercel serverless) and server/server.js (local dev).
   All functions are pure DB/logic operations taking a pg pool.

   Guarantees required by the Project DELTA spec:
   - Sequential user-facing Student IDs assigned by PostgreSQL (101, 102, ...)
   - Face descriptors never leave the server via GET responses
   - Health values are never fabricated: only validated real readings are
     stored, and every reading carries a source + timestamp
   - Duplicate face registration is impossible (threshold check inside enroll)
*/
"use strict";

const FACE_DESCRIPTOR_LENGTH = 128;
const DEFAULT_MATCH_THRESHOLD = 0.6;

/* Wide physiological bounds used to REJECT garbage readings.
   They do not judge health, they only validate type/range. */
const METRIC_VALIDATORS = {
  heart_rate:   { column: "heart_rate_bpm",    unit: "bpm",    min: 30,  max: 220 },
  hrv:          { column: "hrv_ms",            unit: "ms",     min: 5,   max: 400 },
  breathing:    { column: "breathing_rate",    unit: "/min",   min: 4,   max: 45 },
  temperature:  { column: "temperature_c",     unit: "\u00B0C", min: 25, max: 45 },
  hydration:    { column: "hydration_pct",     unit: "%",      min: 0,   max: 100 },
  stress:       { column: "stress_pct",        unit: "%",      min: 0,   max: 100 },
  electrolytes: { column: "electrolytes_pct",  unit: "%",      min: 0,   max: 100 },
  sodium:       { column: "sodium_meq_l",      unit: "mEq/L",  min: 80,  max: 200 },
  lactate:      { column: "lactate_mmol_l",    unit: "mmol/L", min: 0,   max: 25 },
};

const METRIC_ORDER = ["heart_rate", "hrv", "breathing", "stress", "temperature", "hydration", "electrolytes", "sodium", "lactate"];

/* Freshness windows (ms) used to classify stored readings. */
const FRESH_LIVE_MS = 2 * 60 * 1000;
const FRESH_RECENT_MS = 10 * 60 * 1000;
const FRESH_STALE_MS = 6 * 60 * 60 * 1000;

function matchThreshold() {
  const v = Number(process.env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 2 ? v : DEFAULT_MATCH_THRESHOLD;
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function validDescriptor(input) {
  return Array.isArray(input)
    && input.length === FACE_DESCRIPTOR_LENGTH
    && input.every(v => Number.isFinite(Number(v)));
}

function computeAge(dateOfBirth, now) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const ref = now || new Date();
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function freshnessState(recordedAt, now) {
  if (!recordedAt) return "NO_SIGNAL";
  const ageMs = (now || new Date()).getTime() - new Date(recordedAt).getTime();
  if (ageMs < 0 || Number.isNaN(ageMs)) return "NO_SIGNAL";
  if (ageMs <= FRESH_LIVE_MS) return "LIVE";
  if (ageMs <= FRESH_RECENT_MS) return "RECENT";
  if (ageMs <= FRESH_STALE_MS) return "STALE";
  return "NO_SIGNAL";
}

function publicStudent(row) {
  let dob = null;
  if (row.date_of_birth) {
    const d = new Date(row.date_of_birth);
    if (!Number.isNaN(d.getTime())) dob = d.toISOString().slice(0, 10);
  }
  return {
    studentCode: row.student_code != null ? Number(row.student_code) : null,
    name: row.name,
    dateOfBirth: dob,
    age: computeAge(dob),
    legacyAge: row.age != null && !dob ? row.age : null,
    weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
    createdAt: row.created_at || null,
  };
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      age         INT,
      weight_kg   NUMERIC(5,2),
      photo       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE SEQUENCE IF NOT EXISTS student_code_seq START 101;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS student_code BIGINT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_code ON students(student_code);
    UPDATE students SET student_code = nextval('student_code_seq') WHERE student_code IS NULL;
    ALTER TABLE students ALTER COLUMN student_code SET DEFAULT nextval('student_code_seq');
    ALTER TABLE students ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS photo TEXT;
    CREATE TABLE IF NOT EXISTS detection_sessions (
      id           BIGSERIAL PRIMARY KEY,
      client_key   TEXT UNIQUE,
      student_id   INT REFERENCES students(id) ON DELETE CASCADE,
      student_name TEXT,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON detection_sessions(started_at DESC);
    CREATE TABLE IF NOT EXISTS measurements (
      id                 BIGSERIAL PRIMARY KEY,
      session_client_key TEXT,
      student_id         INT REFERENCES students(id) ON DELETE CASCADE,
      student_name       TEXT,
      electrolytes_pct   NUMERIC(5,1),
      hydration_pct      NUMERIC(5,1),
      stress_pct         NUMERIC(5,1),
      sodium_meq_l       NUMERIC(6,1),
      lactate_mmol_l     NUMERIC(4,2),
      temperature_c      NUMERIC(4,1),
      source             TEXT NOT NULL DEFAULT 'unknown',
      recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_measurements_recorded ON measurements(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_measurements_student ON measurements(student_id, recorded_at DESC);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS heart_rate_bpm NUMERIC(6,1);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS hrv_ms NUMERIC(7,1);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS breathing_rate NUMERIC(5,1);
    UPDATE measurements SET source = 'unknown' WHERE source IS NULL;
    ALTER TABLE measurements ALTER COLUMN source SET DEFAULT 'unknown';
    ALTER TABLE measurements ALTER COLUMN source SET NOT NULL;
    CREATE TABLE IF NOT EXISTS face_embeddings (
      id           BIGSERIAL PRIMARY KEY,
      student_id   INT REFERENCES students(id) ON DELETE CASCADE,
      embedding    NUMERIC[] NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_emb_student ON face_embeddings(student_id);
  `);
}

/* Internal: every registered descriptor with its owner. */
async function loadRegistry(pool) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.student_code, s.date_of_birth, s.age, s.weight_kg, e.embedding
     FROM face_embeddings e JOIN students s ON s.id = e.student_id`
  );
  return rows.map(r => ({
    student: publicStudent(r),
    internalId: r.id,
    embedding: r.embedding.map(Number),
  }));
}

/* GET /api/students — profiles only, never embeddings. */
async function listStudents(pool) {
  const { rows } = await pool.query(
    "SELECT id, name, student_code, date_of_birth, age, weight_kg, created_at FROM students ORDER BY student_code"
  );
  return rows.map(publicStudent);
}

/* POST /api/face/match — live descriptor vs registered registry.
   Returns identity info only; registered descriptors stay server-side. */
async function matchFace(pool, descriptor) {
  if (!validDescriptor(descriptor)) {
    return { error: "descriptor must be an array of 128 finite numbers" };
  }
  const vec = descriptor.map(Number);
  const registry = await loadRegistry(pool);
  let best = null;
  for (const entry of registry) {
    const dist = euclidean(vec, entry.embedding);
    if (!best || dist < best.distance) best = { distance: dist, entry };
  }
  const threshold = matchThreshold();
  if (best && best.distance <= threshold) {
    return {
      matched: true,
      student: best.entry.student,
      distance: Number(best.distance.toFixed(4)),
      threshold,
    };
  }
  return { matched: false, distance: best ? Number(best.distance.toFixed(4)) : null, threshold };
}

/* POST /api/students/enroll — creates the student AND stores the face
   reference atomically. Student code comes from the DB sequence.
   Rejects a face that is already registered (prevents duplicates). */
async function enrollStudent(pool, { name, descriptor, dateOfBirth, weightKg, photo }) {
  const cleanName = typeof name === "string" ? name.trim().slice(0, 120) : "";
  if (!cleanName) return { error: "name is required" };
  /* Descriptor is optional (manual registration without a face scan). */
  let vec = null;
  if (descriptor != null) {
    if (!validDescriptor(descriptor)) {
      return { error: "descriptor must be an array of 128 finite numbers" };
    }
    vec = descriptor.map(Number);
    /* Duplicate-face guard: same face must resolve to the SAME student. */
    const dup = await matchFace(pool, vec);
    if (dup.matched) {
      return { conflict: true, student: dup.student };
    }
  }
  let dob = null;
  if (dateOfBirth != null && dateOfBirth !== "") {
    dob = new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime())) return { error: "dateOfBirth must be a valid date" };
    if (computeAge(dob) == null) return { error: "dateOfBirth out of range" };
    dob = dob.toISOString().slice(0, 10);
  }
  let weight = null;
  if (weightKg != null && weightKg !== "") {
    weight = Number(weightKg);
    if (!Number.isFinite(weight) || weight < 2 || weight > 400) {
      return { error: "weightKg must be between 2 and 400 kg" };
    }
  }
  let cleanPhoto = null;
  if (typeof photo === "string" && photo.startsWith("data:image/") && photo.length <= 400000) {
    cleanPhoto = photo;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO students (name, date_of_birth, weight_kg, photo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, student_code, date_of_birth, age, weight_kg, created_at`,
      [cleanName, dob, weight, cleanPhoto]
    );
    if (vec) {
      await client.query(
        "INSERT INTO face_embeddings (student_id, embedding) VALUES ($1, $2)",
        [ins.rows[0].id, vec]
      );
    }
    await client.query("COMMIT");
    return { student: publicStudent(ins.rows[0]) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* GET /api/students/:code */
async function getStudentByCode(pool, code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return { error: "invalid student code" };
  const { rows } = await pool.query(
    `SELECT id, name, student_code, date_of_birth, age, weight_kg, created_at
     FROM students WHERE student_code = $1`, [n]
  );
  if (rows.length === 0) return { notFound: true };
  return { student: publicStudent(rows[0]) };
}

/* GET /api/students/:code/health — latest REAL reading per metric.
   Missing metrics are reported as NO_SIGNAL; values are never invented. */
async function getHealthByCode(pool, code, now) {
  const found = await getStudentByCode(pool, code);
  if (found.error || found.notFound) return found;

  const ref = now || new Date();
  const { rows } = await pool.query(
    `SELECT * FROM measurements
     WHERE student_id = (SELECT id FROM students WHERE student_code = $1)
       AND recorded_at > $2
     ORDER BY recorded_at DESC LIMIT 200`,
    [found.student.studentCode, new Date(ref.getTime() - FRESH_STALE_MS)]
  );

  const metrics = {};
  for (const key of METRIC_ORDER) {
    const def = METRIC_VALIDATORS[key];
    metrics[key] = {
      value: null, unit: def.unit, state: "NO_SIGNAL",
      recordedAt: null, source: null,
    };
  }
  for (const row of rows) {
    for (const key of METRIC_ORDER) {
      const def = METRIC_VALIDATORS[key];
      if (metrics[key].value == null && row[def.column] != null) {
        metrics[key] = {
          value: Number(row[def.column]),
          unit: def.unit,
          state: freshnessState(row.recorded_at, ref),
          recordedAt: row.recorded_at,
          source: row.source || "unknown",
        };
      }
    }
  }
  return { student: found.student, metrics, updatedAt: ref.toISOString() };
}

/* POST /api/measurements — ingestion endpoint for sensors / Raspberry Pi.
   Invalid readings are rejected (never coerced to 0). Every stored value
   keeps its source and timestamp so the dashboard can classify freshness. */
async function insertMeasurement(pool, body) {
  const code = Number(body.studentCode);
  if (!Number.isInteger(code)) return { error: "studentCode is required" };
  const owner = await pool.query("SELECT id FROM students WHERE student_code = $1", [code]);
  if (owner.rowCount === 0) return { error: `no student with studentCode ${code}` };
  const src = typeof body.source === "string" && body.source.trim()
    ? body.source.trim().slice(0, 40) : null;
  if (!src) return { error: "source is required (e.g. temperature_sensor)" };

  let recordedAt = new Date();
  if (body.recordedAt != null) {
    recordedAt = new Date(body.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) return { error: "recordedAt must be a valid ISO timestamp" };
    const skew = Math.abs(Date.now() - recordedAt.getTime());
    if (skew > 24 * 60 * 60 * 1000) return { error: "recordedAt differs more than 24h from server time" };
  }

  const m = body.metrics && typeof body.metrics === "object" ? body.metrics : {};
  const cleaned = {};
  const errors = [];
  let any = false;
  for (const key of Object.keys(m)) {
    const def = METRIC_VALIDATORS[key];
    if (!def) { errors.push(`unknown metric "${key}"`); continue; }
    const raw = m[key];
    if (raw == null || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) { errors.push(`${key} must be a number`); continue; }
    if (v < def.min || v > def.max) {
      errors.push(`${key}=${raw} outside valid range [${def.min}, ${def.max}] ${def.unit}`);
      continue;
    }
    cleaned[key] = v;
    any = true;
  }
  if (!any) {
    if (errors.length === 0) errors.push("no valid metrics supplied");
    return { error: "measurement rejected", errors };
  }
  if (errors.length > 0) return { error: "measurement rejected", errors };

  const cols = ["session_client_key", "student_id", "source", "recorded_at"];
  const values = [
    typeof body.sessionClientKey === "string" ? body.sessionClientKey.slice(0, 64) : null,
    owner.rows[0].id,
    src,
    recordedAt.toISOString(),
  ];
  const placeholders = ["$1", "$2", "$3", "$4"];
  for (const key of METRIC_ORDER) {
    if (cleaned[key] == null) continue;
    cols.push(METRIC_VALIDATORS[key].column);
    placeholders.push(`$${placeholders.length + 1}`);
    values.push(cleaned[key]);
  }
  const sql = `INSERT INTO measurements (${cols.join(", ")})
               VALUES (${placeholders.join(", ")})
               RETURNING id, recorded_at`;
  const { rows } = await pool.query(sql, values);
  return { ok: true, id: rows[0].id, recordedAt: rows[0].recorded_at, metrics: cleaned, source: src };
}

/* POST /api/sessions — monitoring session binds sensor data to one student. */
async function startSession(pool, { clientKey, studentCode }) {
  const key = typeof clientKey === "string" && clientKey.trim()
    ? clientKey.trim().slice(0, 64) : null;
  if (!key) return { error: "clientKey required" };
  let n = null;
  if (studentCode != null && studentCode !== "") {
    n = Number(studentCode);
    if (!Number.isInteger(n)) return { error: "invalid studentCode" };
  }
  const { rows } = await pool.query(
    `INSERT INTO detection_sessions (client_key, student_id, student_name)
     SELECT $1,
            (SELECT id FROM students WHERE student_code = $2),
            (SELECT name FROM students WHERE student_code = $2)
     ON CONFLICT (client_key) DO UPDATE SET ended_at = NULL,
       student_id = EXCLUDED.student_id,
       student_name = EXCLUDED.student_name
     RETURNING id, client_key, started_at`,
    [key, n]
  );
  return { ok: true, ...rows[0] };
}

async function endSession(pool, clientKey) {
  if (!clientKey) return { error: "clientKey required" };
  const { rowCount } = await pool.query(
    `UPDATE detection_sessions SET ended_at = now()
     WHERE client_key = $1 AND ended_at IS NULL`,
    [String(clientKey).slice(0, 64)]
  );
  return { ok: true, updated: rowCount };
}

module.exports = {
  FACE_DESCRIPTOR_LENGTH,
  METRIC_ORDER,
  METRIC_VALIDATORS,
  ensureSchema,
  listStudents,
  matchFace,
  enrollStudent,
  getStudentByCode,
  getHealthByCode,
  insertMeasurement,
  startSession,
  endSession,
  computeAge,
  freshnessState,
};
