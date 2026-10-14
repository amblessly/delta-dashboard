/* Project DELTA shared backend library.
   Used by BOTH api/*.js (Vercel serverless) and server/server.js (local dev).
   All functions are pure DB/logic operations taking a pg pool.

   Guarantees required by the Project DELTA spec:
   - Sequential user-facing Student IDs assigned by PostgreSQL (101, 102, ...)
   - Health values are never fabricated: only validated real readings are
     stored, and every reading carries a source + timestamp
*/
"use strict";

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

/* Estimate hydration level from available measurements.
   This is an ESTIMATED indicator, not a direct measurement. */
function calculateHydration(healthMetrics) {
  if (!healthMetrics) return { value: null, confidence: 0, label: "Insufficient data" };

  const components = [];
  let totalWeight = 0;
  let totalScore = 0;

  // Electrolyte score contribution (0-100 scale, higher = better)
  const el = healthMetrics.electrolytes;
  if (el && el.value != null && el.state !== "NO_SIGNAL") {
    // 50% electrolytes is ideal center
    const elScore = 100 - Math.abs(el.value - 50) * 2;
    const w = 0.30;
    totalScore += Math.max(0, Math.min(100, elScore)) * w;
    totalWeight += w;
    components.push("electrolytes");
  }

  // Temperature contribution (inverse: higher temp = lower hydration)
  const temp = healthMetrics.temperature;
  if (temp && temp.value != null && temp.state !== "NO_SIGNAL") {
    const baseline = 36.8;
    const delta = temp.value - baseline;
    const tempScore = Math.max(0, 100 - delta * 25);
    const w = 0.25;
    totalScore += Math.max(0, Math.min(100, tempScore)) * w;
    totalWeight += w;
    components.push("temperature");
  }

  // Sodium contribution (ideal ~140 mEq/L)
  const na = healthMetrics.sodium;
  if (na && na.value != null && na.state !== "NO_SIGNAL") {
    const naDelta = Math.abs(na.value - 140);
    const naScore = Math.max(0, 100 - naDelta * 3);
    const w = 0.25;
    totalScore += naScore * w;
    totalWeight += w;
    components.push("sodium");
  }

  // Lactate contribution (lower is better)
  const lac = healthMetrics.lactate;
  if (lac && lac.value != null && lac.state !== "NO_SIGNAL") {
    const lacScore = Math.max(0, 100 - lac.value * 20);
    const w = 0.20;
    totalScore += lacScore * w;
    totalWeight += w;
    components.push("lactate");
  }

  if (totalWeight === 0) return { value: null, confidence: 0, label: "Insufficient data" };

  const value = Math.round(totalScore / totalWeight);
  const confidence = Math.round(totalWeight * 100);

  let label = "Estimated Hydration";
  if (value < 30) label = "Hydration indicator critically low";
  else if (value < 50) label = "Hydration indicator low";
  else if (value < 70) label = "Hydration indicator moderate";
  else label = "Hydration indicator adequate";

  return { value, confidence, label, components };
}

/* Generate EXACTLY 3 recommendations from current health metrics.
   Ranked by severity × confidence × relevance. */
function generateRecommendations(healthMetrics, hydrationResult) {
  const candidates = [];

  // Hydration recommendation
  if (hydrationResult && hydrationResult.value != null) {
    if (hydrationResult.value < 30) {
      candidates.push({ severity: 90, confidence: hydrationResult.confidence, priority: 90,
        title: "Hydration concern", theme: "red", icon: "droplet",
        text: `Estimated hydration indicator is critically low at ${hydrationResult.value}%. Rest immediately and drink water. If symptoms persist, seek medical attention.` });
    } else if (hydrationResult.value < 50) {
      candidates.push({ severity: 60, confidence: hydrationResult.confidence, priority: 60,
        title: "Hydration indicator low", theme: "amber", icon: "droplet",
        text: `Estimated hydration indicator is ${hydrationResult.value}%. Take a break and drink water to restore fluid balance.` });
    } else if (hydrationResult.value < 70) {
      candidates.push({ severity: 30, confidence: hydrationResult.confidence, priority: 30,
        title: "Hydration moderate", theme: "amber", icon: "droplet",
        text: `Estimated hydration indicator is ${hydrationResult.value}%. Consider drinking water proactively.` });
    } else {
      candidates.push({ severity: 5, confidence: hydrationResult.confidence, priority: 5,
        title: "Hydration adequate", theme: "green", icon: "droplet",
        text: `Estimated hydration indicator is ${hydrationResult.value}%. Continue normal hydration.` });
    }
  }

  // Temperature recommendation
  const temp = healthMetrics.temperature;
  if (temp && temp.value != null && temp.state !== "NO_SIGNAL") {
    const baseline = 36.8;
    const delta = temp.value - baseline;
    if (delta >= 1.5) {
      candidates.push({ severity: 80, confidence: 70, priority: 80,
        title: "Temperature elevated", theme: "red", icon: "flask",
        text: `Temperature of ${Number(temp.value).toFixed(1)}°C is ${Number(delta).toFixed(1)}°C above baseline. Rest in a cool area and recheck after 10 minutes.` });
    } else if (delta >= 0.7) {
      candidates.push({ severity: 50, confidence: 65, priority: 50,
        title: "Temperature above baseline", theme: "amber", icon: "flask",
        text: `Temperature of ${Number(temp.value).toFixed(1)}°C is slightly above baseline. Monitor closely and rest if needed.` });
    } else {
      candidates.push({ severity: 5, confidence: 60, priority: 5,
        title: "Temperature normal", theme: "green", icon: "flask",
        text: `Temperature of ${Number(temp.value).toFixed(1)}°C is within expected range. No action needed.` });
    }
  }

  // Electrolyte recommendation
  const el = healthMetrics.electrolytes;
  if (el && el.value != null && el.state !== "NO_SIGNAL") {
    if (el.value < 20) {
      candidates.push({ severity: 75, confidence: 60, priority: 75,
        title: "Electrolyte measurement low", theme: "red", icon: "flask",
        text: `Electrolyte reading of ${Number(el.value).toFixed(1)}% is below expected range. Recheck the sample and ensure proper test strip handling.` });
    } else if (el.value > 80) {
      candidates.push({ severity: 55, confidence: 55, priority: 55,
        title: "Electrolyte measurement elevated", theme: "amber", icon: "flask",
        text: `Electrolyte reading of ${Number(el.value).toFixed(1)}% is above expected range. Verify calibration and recheck.` });
    } else {
      candidates.push({ severity: 5, confidence: 50, priority: 5,
        title: "Electrolytes normal", theme: "green", icon: "flask",
        text: `Electrolyte reading of ${Number(el.value).toFixed(1)}% is within normal range.` });
    }
  }

  // Sodium recommendation
  const na = healthMetrics.sodium;
  if (na && na.value != null && na.state !== "NO_SIGNAL") {
    if (na.value < 130 || na.value > 155) {
      candidates.push({ severity: 65, confidence: 55, priority: 65,
        title: "Sodium level abnormal", theme: "amber", icon: "flask",
        text: `Sodium level of ${Number(na.value).toFixed(1)} mEq/L is outside the normal range (130-155). Review electrolyte balance and recheck.` });
    }
  }

  // Lactate recommendation
  const lac = healthMetrics.lactate;
  if (lac && lac.value != null && lac.state !== "NO_SIGNAL") {
    if (lac.value >= 4.0) {
      candidates.push({ severity: 70, confidence: 50, priority: 70,
        title: "Lactate level elevated", theme: "red", icon: "flask",
        text: `Lactate level of ${Number(lac.value).toFixed(2)} mmol/L is elevated. This may indicate anaerobic activity. Rest and recheck.` });
    }
  }

  // Sort by priority descending
  candidates.sort((a, b) => b.priority - a.priority);

  // Take top 3
  const result = candidates.slice(0, 3);

  // Fill remaining slots up to 3 with generic guidance
  const genericGuidance = [
    { severity: 0, confidence: 0, priority: 0, title: "Recovery guidance", theme: "green", icon: "droplet",
      text: "Maintain regular hydration and balanced nutrition throughout the day." },
    { severity: 0, confidence: 0, priority: 0, title: "Activity guidance", theme: "green", icon: "lungs",
      text: "Listen to your body and take breaks as needed during physical activity." },
    { severity: 0, confidence: 0, priority: 0, title: "Monitoring guidance", theme: "green", icon: "flask",
      text: "Regular monitoring helps track trends over time. Check measurements periodically." },
  ];

  while (result.length < 3 && genericGuidance.length > 0) {
    result.push(genericGuidance.shift());
  }

  return result;
}

function publicStudent(row) {
  let dob = null;
  if (row.date_of_birth) {
    const d = new Date(row.date_of_birth);
    if (!Number.isNaN(d.getTime())) dob = d.toISOString().slice(0, 10);
  }
  const computedAge = computeAge(dob);
  const storedAge = row.age != null ? Number(row.age) : null;
  return {
    studentCode: row.student_code != null ? Number(row.student_code) : null,
    name: row.name,
    dateOfBirth: dob,
    age: computedAge != null ? computedAge : storedAge,
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
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE SEQUENCE IF NOT EXISTS student_code_seq START 101;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS student_code BIGINT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_code ON students(student_code);
    UPDATE students SET student_code = nextval('student_code_seq') WHERE student_code IS NULL;
    ALTER TABLE students ALTER COLUMN student_code SET DEFAULT nextval('student_code_seq');
    ALTER TABLE students ADD COLUMN IF NOT EXISTS date_of_birth DATE;
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
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS temperature_baseline NUMERIC(4,1);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS temperature_delta NUMERIC(4,2);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS temperature_confidence NUMERIC(3,2);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS electrolyte_confidence NUMERIC(3,2);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS measurement_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_measurements_measurement_id ON measurements(measurement_id) WHERE measurement_id IS NOT NULL;
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS hydration_baseline NUMERIC(5,1);
    ALTER TABLE measurements ADD COLUMN IF NOT EXISTS hydration_confidence NUMERIC(3,2);
  `);
}

/* GET /api/students */
async function listStudents(pool) {
  const { rows } = await pool.query(
    "SELECT id, name, student_code, date_of_birth, age, weight_kg, created_at FROM students ORDER BY student_code"
  );
  return rows.map(publicStudent);
}

/* POST /api/students/enroll — name + age + weight registration. */
async function enrollStudent(pool, { name, age, dateOfBirth, weightKg }) {
  const cleanName = typeof name === "string" ? name.trim().slice(0, 120) : "";
  if (!cleanName) return { error: "name is required" };
  let dob = null;
  if (dateOfBirth != null && dateOfBirth !== "") {
    dob = new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime())) return { error: "dateOfBirth must be a valid date" };
    if (computeAge(dob) == null) return { error: "dateOfBirth out of range" };
    dob = dob.toISOString().slice(0, 10);
  }
  let ageVal = null;
  if (age != null && age !== "") {
    ageVal = Number(age);
    if (!Number.isInteger(ageVal) || ageVal < 1 || ageVal > 150) {
      return { error: "age must be between 1 and 150" };
    }
  }
  let weight = null;
  if (weightKg != null && weightKg !== "") {
    weight = Number(weightKg);
    if (!Number.isFinite(weight) || weight < 2 || weight > 400) {
      return { error: "weightKg must be between 2 and 400 kg" };
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO students (name, age, date_of_birth, weight_kg)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, student_code, date_of_birth, age, weight_kg, created_at`,
    [cleanName, ageVal, dob, weight]
  );
  return { student: publicStudent(rows[0]) };
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

/* GET /api/students/:code/health — latest REAL reading per metric. */
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
        if (key === "temperature") {
          if (row.temperature_baseline != null) metrics[key].baseline = Number(row.temperature_baseline);
          if (row.temperature_delta != null) metrics[key].delta = Number(row.temperature_delta);
          if (row.temperature_confidence != null) metrics[key].confidence = Number(row.temperature_confidence);
        }
        if (key === "electrolytes" && row.electrolyte_confidence != null) {
          metrics[key].confidence = Number(row.electrolyte_confidence);
        }
      }
    }
  }

  // Estimated hydration
  const hydResult = calculateHydration(metrics);
  if (hydResult.value != null) {
    metrics.hydration = {
      value: hydResult.value, unit: "%", state: freshnessState(ref, ref),
      recordedAt: ref.toISOString(), source: "estimated",
      confidence: hydResult.confidence, label: hydResult.label,
      components: hydResult.components, isEstimated: true,
    };
  }

  return { student: found.student, metrics, updatedAt: ref.toISOString() };
}

/* POST /api/measurements */
async function insertMeasurement(pool, body) {
  const code = Number(body.studentCode);
  if (!Number.isInteger(code)) return { error: "studentCode is required" };
  const owner = await pool.query("SELECT id FROM students WHERE student_code = $1", [code]);
  if (owner.rowCount === 0) return { error: `no student with studentCode ${code}` };
  const src = typeof body.source === "string" && body.source.trim()
    ? body.source.trim().slice(0, 40) : null;
  if (!src) return { error: "source is required (e.g. temperature_sensor)" };

  // Deduplication via measurement_id
  const mid = typeof body.measurementId === "string" && body.measurementId.trim()
    ? body.measurementId.trim().slice(0, 128) : null;
  if (mid) {
    const dup = await pool.query("SELECT id FROM measurements WHERE measurement_id = $1", [mid]);
    if (dup.rowCount > 0) return { ok: true, id: dup.rows[0].id, duplicate: true };
  }

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

  if (mid) { cols.push("measurement_id"); placeholders.push(`$${placeholders.length + 1}`); values.push(mid); }

  // Temperature confidence fields
  const tempConf = body.temperatureConfidence;
  if (tempConf && typeof tempConf === "object") {
    if (tempConf.baseline != null) { cols.push("temperature_baseline"); placeholders.push(`$${placeholders.length + 1}`); values.push(Number(tempConf.baseline)); }
    if (tempConf.delta != null) { cols.push("temperature_delta"); placeholders.push(`$${placeholders.length + 1}`); values.push(Number(tempConf.delta)); }
    if (tempConf.confidence != null) { cols.push("temperature_confidence"); placeholders.push(`$${placeholders.length + 1}`); values.push(Number(tempConf.confidence)); }
  }

  // Electrolyte confidence
  if (body.electrolyteConfidence != null) {
    cols.push("electrolyte_confidence"); placeholders.push(`$${placeholders.length + 1}`); values.push(Number(body.electrolyteConfidence));
  }

  // Hydration baseline + confidence
  if (body.hydrationBaseline != null) { cols.push("hydration_baseline"); placeholders.push(`$${placeholders.length + 1}`); values.push(Number(body.hydrationBaseline)); }
  if (body.hydrationConfidence != null) { cols.push("hydration_confidence"); placeholders.push(`$${placeholders.length + 1}`); values.push(Number(body.hydrationConfidence)); }

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

/* POST /api/sessions */
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

async function getSessionSummary(pool, clientKey) {
  const key = String(clientKey).slice(0, 64);
  const sess = await pool.query(
    `SELECT * FROM detection_sessions WHERE client_key = $1`, [key]
  );
  if (sess.rowCount === 0) return { error: "session not found" };
  const session = sess.rows[0];
  const { rows: measurements } = await pool.query(
    `SELECT m.*, s.student_code AS "studentCode"
     FROM measurements m LEFT JOIN students s ON s.id = m.student_id
     WHERE m.session_client_key = $1
     ORDER BY m.recorded_at ASC`, [key]
  );
  const summary = {};
  for (const [key, def] of Object.entries(METRIC_VALIDATORS)) {
    const vals = measurements
      .map(r => r[def.column] != null ? Number(r[def.column]) : null)
      .filter(v => v != null);
    if (vals.length === 0) continue;
    summary[key] = {
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      last: vals[vals.length - 1],
      count: vals.length,
      unit: def.unit,
    };
  }
  return {
    session: { ...session, durationMs: session.ended_at && session.started_at
      ? new Date(session.ended_at) - new Date(session.started_at) : null },
    measurements,
    summary,
  };
}

module.exports = {
  METRIC_ORDER,
  METRIC_VALIDATORS,
  ensureSchema,
  listStudents,
  enrollStudent,
  getStudentByCode,
  getHealthByCode,
  insertMeasurement,
  startSession,
  endSession,
  getSessionSummary,
  computeAge,
  freshnessState,
  calculateHydration,
  generateRecommendations,
};
