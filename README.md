# Project DELTA — Student Identification & Health Data Workflow

A student identification and health monitoring workflow:

```text
CAMERA
  ↓
FACE DETECTION
  ↓
FACE RECOGNITION (match against registered descriptors in PostgreSQL)
  ↓
STUDENT ID (sequential: 101, 102, ...)
  ↓
STUDENT PROFILE
  ↓
HEALTH DATA (real sensor readings only)
  ↓
PROJECT DELTA DASHBOARD
```

The system supports **new students** (registration with automatic ID
assignment) and **returning students** (recognized by face — never
re-registered).

---

## Architecture

| Layer | Technology | Runs where |
|---|---|---|
| Dashboard UI | Vanilla JS | Browser |
| Session data website | Vanilla JS (`sessions.html`) | Browser, same port |
| Camera capture | Pi camera / webcam | Browser + Raspberry Pi |
| Face detection & recognition | face-api.js (browser) + server-side descriptor matching | Browser + backend |
| API + identity | Node.js server (local) | localhost:8000 |
| Database | PostgreSQL (Neon) | Cloud |
| Health sensors | POST validated readings to `/api/measurements` | Raspberry Pi |

Identity data (who the student is) and health data (current measurements)
are strictly separated. Registered face descriptors are **never sent to
clients**.

---

## Current implementation status

Read this before testing — it says exactly what runs today.

| Part | State | Where |
|---|---|---|
| Kiosk dashboard, student selection, monitoring session | ✅ **live** | `index.html`, `main.js` |
| Session data website + CSV export | ✅ **live** | `sessions.html`, `api/_history.js` |
| Sensor ingestion, validation, database | ✅ **live** | `server/server.js`, `api/_lib.js` |
| Face detection + recognition | ⚠️ **in `_legacy/` only** | `_legacy/health-dashboard/` |

MLX is not part of this build. `thermal-panel.js` still exists in the repo
but no thermal sensor is connected, so no thermal readings are collected.

### Face recognition

The face-recognition implementation (face-api.js, the TinyFaceDetector /
Landmark68 / RecognitionNet models, descriptor matching) is **kept in
`_legacy/health-dashboard/`**. The live dashboard identifies a student by
**manual selection**: tap the student in the list, or tap
`+ NEW STUDENT` to register one.

To bring recognition into the live app, copy from `_legacy/health-dashboard/`:
`face-api.min.js` and `models/`, then restore the recognition flow in
`main.js` and add the `face_embeddings` table plus `POST /api/face/match`
(both are documented in the legacy folder). Confirm with the team which
version will be used before testing.

---

## How It Works

1. Open the dashboard → student selection panel appears
2. Select a student from the list, or tap "+ NEW STUDENT" to register
3. Dashboard opens with identity + real health readings (or `NO SIGNAL`)
4. Health metrics update every 8 seconds from sensor data
5. While a student is selected, a monitoring session binds sensor data to
   that student; the dashboard polls `/api/students/:code/health`
6. When the session ends, its readings are listed on the session data
   website and can be exported as CSV for the data collection sheet

### Honest Health Data Policy

The dashboard **never fabricates health values**:

- **Age** — computed by the backend from `date_of_birth`
- **Weight** — from the student profile (validated manual input)
- **Health metrics** — only from real readings submitted with a `source`
  and timestamp. Each value is range/type validated; invalid readings are
  rejected (never coerced to 0). Without a reading the UI shows
  `STANDBY` / `NO SIGNAL`.

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
physiological bounds return `400`. Each reading is stored with the session
that was running when it arrived.

---

## Local Development

1. Create the env file: copy `.env.example` → `server/.env`, set `DATABASE_URL`
2. Apply/migrate schema (idempotent): `cd server && npm run setup-db`
   (the server also migrates automatically on boot)
3. Start the dashboard + API: `cd server && npm start` → http://localhost:8000
4. Session data website → http://localhost:8000/sessions.html
   (see `SESSION-DASHBOARD.md`)

Camera access requires localhost or HTTPS (secure context).

---

## Session Data Website

`sessions.html` lists every recorded session, shows the readings of each one
and exports them as CSV for the data collection sheet:

```bash
curl -s localhost:8000/api/stats                    # overview
curl -s localhost:8000/api/sessions                 # session history
curl -sO localhost:8000/api/sessions/KEY/export.csv # one session as CSV
```

Full setup, backup and troubleshooting: [`SESSION-DASHBOARD.md`](SESSION-DASHBOARD.md).

---

## Raspberry Pi Setup

```bash
cd _pi-setup
bash raspberry-pi/install.sh                  # system packages + Node + npm + schema
sudo bash raspberry-pi/install-services.sh    # autostart on boot (kiosk)
sudo reboot
```

`install.sh` stops and asks for the database URL before applying the schema —
fill in `server/.env` when prompted.

Services installed: `delta-server` (API + kiosk + session website),
`delta-kiosk` (Chromium fullscreen), `delta-camera` (camera reader).

**Setting this up with an AI agent?** Give it `SESSION-DASHBOARD.md`
section 0 — it lists every command, the expected output, and the rules.

---

## Database

Tables (see `server/schema.sql`):

- **students** — `student_code BIGINT UNIQUE` assigned by sequence
  `student_code_seq START 101` (database-guaranteed uniqueness),
  `name`, `date_of_birth` (age computed from it), `weight_kg`
- **detection_sessions** — monitoring sessions binding sensor data to one
  student (`client_key` unique, `started_at`, `ended_at`)
- **measurements** — validated readings with `source` + `recorded_at`, tied
  to a session by `session_client_key`

A reading is stored with the session that was running when it arrived; the
server attaches that key on ingest. Readings recorded before that linking
existed are attributed by session time window and marked
`session_match = time_window` in the website and in CSV exports.

---

## API Endpoints

| Method & Path | Purpose |
|---|---|
| GET `/api/health` | DB connectivity check |
| GET `/api/students` | Profiles (no biometric data) |
| GET `/api/students/:code` | One profile by Student ID |
| GET `/api/students/:code/health` | Real health state per metric |
| POST `/api/students/enroll` | Register new student |
| POST `/api/sessions` / `POST /api/sessions/end` | Monitoring session lifecycle |
| GET/POST `/api/measurements` | List / ingest validated readings |
| GET `/api/stats` | Session website overview counters |
| GET `/api/sessions?limit=&page=&q=&from=&to=&status=` | Session history with record counts |
| GET `/api/sessions/:key/records` | Readings recorded during one session |
| GET `/api/sessions/:key/export.csv` | CSV export (`:key` = session id, `all`, `unassigned`) |

---

## Security Notes

- Face descriptors are compared server-side and never exposed via GET endpoints
- Health values are never fabricated: only validated real readings are stored
- Sequential Student IDs are generated exclusively by the PostgreSQL sequence
- Keep `DATABASE_URL` in `server/.env` (git-ignored); never commit `.env`
- The session website is read-only and intended for the local network —
  do not forward port 8000 to the internet