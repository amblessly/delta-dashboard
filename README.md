# Project DELTA — Student Identification & Health Data Workflow

A production-ready student identification and health monitoring workflow:

```text
CAMERA
  ↓
FACE DETECTION (face-api.js, browser)
  ↓
FACE RECOGNITION (server-side matching against PostgreSQL)
  ↓
STUDENT ID (sequential: 101, 102, ...)
  ↓
STUDENT PROFILE
  ↓
HEALTH DATA (real sensor readings only)
  ↓
PROJECT DELTA DASHBOARD
```

The system supports **new students** (registration with automatic ID assignment)
and **returning students** (recognized by face — never re-registered).

---

## Architecture

| Layer | Technology | Runs where |
|---|---|---|
| Dashboard UI | Vanilla JS + face-api.js | Browser |
| Face detection | TinyFaceDetector + Landmark68 + RecognitionNet (models in `/models`) | Browser |
| Face matching | Euclidean distance vs registered descriptors, threshold-gated | Backend (`api/` or `server/`) |
| API + identity | Node.js serverless functions / local Node server | Vercel or localhost:8000 |
| Database | PostgreSQL (Neon) — students, face_embeddings, detection_sessions, measurements | Cloud |
| Optional detector/embedding accelerator | Python + InsightFace (`human-detection/face_service.py`) | Raspberry Pi / PC |
| Sensors | POST validated readings to `/api/measurements` | Raspberry Pi |

Identity data (who the student is) and health data (current measurements) are
strictly separated. Registered face descriptors are **never sent to clients**.

---

## How It Works

1. Open the dashboard → camera starts → `NO USER DETECTED`
2. A person faces the camera → single good-quality face required
3. The 128-d descriptor is matched **server-side** against registered faces:
   - **Match ≥ threshold (0.6 default)** on stable consecutive frames →
     `STUDENT RECOGNIZED` → profile loads → dashboard shows identity +
     real health readings (or explicit `NO SIGNAL` states)
   - **No valid match** on stable consecutive frames → `NEW STUDENT DETECTED`
     → registration modal (name, date of birth, weight) → save → the database
     assigns the next sequential Student ID (101, 102, ...) → dashboard opens
4. While a student is recognized, a monitoring session binds sensor data to
   that student; the dashboard polls `/api/students/:code/health`

---

## Honest Health Data Policy

The dashboard **never fabricates health values**:

- **Age** — computed by the backend from `date_of_birth`
- **Weight** — from the student profile (validated manual input at
  registration; a scale integration can write it via `/api/measurements`)
- **Temperature / Hydration / Stress / Electrolytes / Sodium / Lactate** —
  only from real readings submitted to `/api/measurements` with a `source`
  and timestamp. Each value is range/type validated; invalid readings are
  rejected (never coerced to 0). Without a reading the UI shows
  `STANDBY` / `NO SIGNAL --`, classified as `LIVE` (≤2 min), `RECENT`
  (≤10 min), `STALE` (≤6 h) or `NO SIGNAL`.

Recommendations are derived strictly from measured values, or display
`AWAITING VALID HEALTH DATA`.

---

## Sensor Ingestion (Raspberry Pi)

```bash
curl -X POST http://localhost:8000/api/measurements \
  -H "Content-Type: application/json" \
  -d '{
    "studentCode": 101,
    "source": "temperature_sensor",
    "metrics": { "temperature": 36.7 }
  }'
```

Readings must include `studentCode` and `source`; metrics outside valid
physiological bounds return `400`.

---

## Local Development

1. Create the env file: copy `.env.example` → `server/.env`, set `DATABASE_URL`
2. Apply/migrate schema (idempotent): `cd server && npm run setup-db`
   (the server also migrates automatically on boot)
3. Start the dashboard + API: `cd server && npm start` → http://localhost:8000

Camera access requires localhost or HTTPS (secure context).

## Vercel Deployment

- Static frontend is served from the repo root; API routes live in `api/`
- Set `DATABASE_URL` (+ optionally `FACE_MATCH_THRESHOLD`) in project env vars
- Run `server/setup-db.js` once against the production database to apply the
  idempotent schema migration
- Long-running processes (camera streams, sensors) stay off Vercel — they run
  on the Raspberry Pi and push data through the API

## Database

Tables (see `server/schema.sql`):

- **students** — `student_code BIGINT UNIQUE` assigned by sequence
  `student_code_seq START 101` (database-guaranteed uniqueness),
  `name`, `date_of_birth` (age computed from it), `weight_kg`, `photo`
- **face_embeddings** — 128-d descriptors per student (internal `students.id` FK)
- **detection_sessions** — monitoring sessions binding sensor data to one student
- **measurements** — validated readings with `source` + `recorded_at`

Duplicate registration is impossible: enrollment first checks the new face
against all registered descriptors and returns HTTP 409 with the existing
student when the same face is already known.

## API Endpoints

| Method & Path | Purpose |
|---|---|
| GET `/api/health` | DB connectivity check |
| GET `/api/students` | Profiles (no biometric data) |
| GET `/api/students/:code` | One profile by Student ID |
| GET `/api/students/:code/health` | Real health state per metric |
| POST `/api/students/enroll` | Register new student + face reference |
| POST `/api/face/match` | Match live descriptor → identity or UNKNOWN |
| POST `/api/sessions` / `POST /api/sessions/end` | Monitoring session lifecycle |
| GET/POST `/api/measurements` | List / ingest validated readings |

---

## Security Notes

- Face descriptors are compared server-side and never exposed via GET endpoints
- Raw biometric data is not logged
- Sequential Student IDs are generated exclusively by the PostgreSQL sequence
- Keep `DATABASE_URL` in environment variables; never commit `.env`
