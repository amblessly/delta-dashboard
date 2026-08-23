-- Project DELTA dashboard schema (Neon PostgreSQL)
-- Mirrors what the dashboard displays: student profile, detection
-- sessions, and the six live metric values.

CREATE TABLE IF NOT EXISTS students (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  age         INT,
  weight_kg   NUMERIC(5,2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS detection_sessions (
  id           BIGSERIAL PRIMARY KEY,
  client_key   TEXT UNIQUE,                -- browser-generated session id
  student_id   INT REFERENCES students(id),
  student_name TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON detection_sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS measurements (
  id                 BIGSERIAL PRIMARY KEY,
  session_client_key TEXT,                 -- matches detection_sessions.client_key
  student_name       TEXT,
  electrolytes_pct   NUMERIC(5,1),         -- ELECTROLYTES %
  hydration_pct      NUMERIC(5,1),         -- HYDRATION %
  stress_pct         NUMERIC(5,1),         -- STRESS %
  sodium_meq_l       NUMERIC(6,1),         -- SODIUM Na+ mEq/L
  lactate_mmol_l     NUMERIC(4,2),         -- LACTATE mmol/L
  temperature_c      NUMERIC(4,1),         -- TEMPERATURE degC
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_measurements_recorded ON measurements(recorded_at DESC);

-- Seed dashboard student (idempotent)
INSERT INTO students (name, age, weight_kg)
SELECT 'Princess Ronday', 18, 54.2
WHERE NOT EXISTS (SELECT 1 FROM students WHERE name = 'Princess Ronday');
