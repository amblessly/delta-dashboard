-- Project DELTA dashboard schema (Neon PostgreSQL)

CREATE TABLE IF NOT EXISTS students (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  age         INT,
  weight_kg   NUMERIC(5,2),
  photo       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_measurements_recorded ON measurements(recorded_at DESC);

-- Face embeddings for facial recognition enrollment
CREATE TABLE IF NOT EXISTS face_embeddings (
  id           BIGSERIAL PRIMARY KEY,
  student_id   INT REFERENCES students(id) ON DELETE CASCADE,
  embedding    NUMERIC[] NOT NULL,          -- 128-dimensional Float32 vector stored as float[]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emb_student ON face_embeddings(student_id);
