-- Project DELTA schema (Neon PostgreSQL)
-- Every statement is idempotent; safe to re-run (server/setup-db.js, server boot auto-migration).

CREATE TABLE IF NOT EXISTS students (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  age         INT,                -- legacy column; kept for old rows, new code uses date_of_birth
  weight_kg   NUMERIC(5,2),
  photo       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sequential user-facing Student IDs (101, 102, ...) ──────────────
-- Assigned by the database via DEFAULT nextval(); the backend never
-- generates IDs in application/frontend code.
CREATE SEQUENCE IF NOT EXISTS student_code_seq START 101;
ALTER TABLE students ADD COLUMN IF NOT EXISTS student_code BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_code ON students(student_code);
UPDATE students SET student_code = nextval('student_code_seq') WHERE student_code IS NULL;
ALTER TABLE students ALTER COLUMN student_code SET DEFAULT nextval('student_code_seq');

-- ── Date of birth (age is computed from it, never hardcoded) ────────
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

-- Health measurements. Only real sensor/validated readings may be
-- inserted (API rejects invalid values); source records where each
-- reading came from (e.g. temperature_sensor).
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

-- Face embeddings for facial recognition enrollment (128-d face-api.js
-- descriptors). Never exposed through public GET endpoints.
CREATE TABLE IF NOT EXISTS face_embeddings (
  id           BIGSERIAL PRIMARY KEY,
  student_id   INT REFERENCES students(id) ON DELETE CASCADE,
  embedding    NUMERIC[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emb_student ON face_embeddings(student_id);
