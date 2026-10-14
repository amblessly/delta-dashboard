# Project DELTA — Student Health Data Workflow

A student health monitoring dashboard with real sensor data:

```text
RASPBERRY PI CAMERA (strip detection)
  ↓
MLX90640 THERMAL CAMERA (temperature)
  ↓
STUDENT ID (manual selection: 101, 102, ...)
  ↓
STUDENT PROFILE
  ↓
HEALTH DATA (real sensor readings only)
  ↓
PROJECT DELTA DASHBOARD
```

The system supports **manual student selection** from a list and
**new student registration** with automatic ID assignment.

---

## Architecture

| Layer | Technology | Runs where |
|---|---|---|
| Dashboard UI | Vanilla JS | Browser |
| Thermal sensor | Python + adafruit-mlx90640 | Raspberry Pi |
| API + identity | Node.js server | Localhost:8000 |
| Database | PostgreSQL (Neon) | Cloud |
| Sensors | POST validated readings to `/api/measurements` | Raspberry Pi |

---

## How It Works

1. Open the dashboard → student selection panel appears
2. Select a student from the list, or tap "+ NEW STUDENT" to register
3. Dashboard opens with identity + real health readings (or `NO SIGNAL`)
4. Thermal heatmap shows live MLX90640 data
5. Health metrics update every 8 seconds from sensor data

---

## Honest Health Data Policy

The dashboard **never fabricates health values**:

- **Age** — computed by the backend from `date_of_birth`
- **Weight** — from the student profile (validated manual input)
- **Temperature** — from MLX90640 thermal sensor via `/api/measurements`
- **Other metrics** — only from real readings submitted with a `source`
  and timestamp. Without a reading the UI shows `STANDBY` / `NO SIGNAL`.

---

## Sensor Ingestion (Raspberry Pi)

```bash
curl -X POST http://localhost:8000/api/measurements \
  -H "Content-Type: application/json" \
  -d '{
    "studentCode": 101,
    "source": "mlx90640_thermal",
    "metrics": { "temperature": 36.7 }
  }'
```

Readings must include `studentCode` and `source`; metrics outside valid
physiological bounds return `400`.

---

## Local Development

1. Create the env file: copy `.env.example` → `server/.env`, set `DATABASE_URL`
2. Apply/migrate schema: `cd server && npm run setup-db`
3. Start the dashboard + API: `cd server && npm start` → http://localhost:8000

## Raspberry Pi Setup

```bash
bash raspberry-pi/install.sh           # install system packages + deps
sudo bash raspberry-pi/install-services.sh  # enable autostart on boot
sudo reboot
```

## Database

Tables (see `server/schema.sql`):

- **students** — `student_code BIGINT UNIQUE` assigned by sequence
  `student_code_seq START 101`, `name`, `date_of_birth`, `weight_kg`
- **detection_sessions** — monitoring sessions binding sensor data
- **measurements** — validated readings with `source` + `recorded_at`

## API Endpoints

| Method & Path | Purpose |
|---|---|
| GET `/api/health` | DB connectivity check |
| GET `/api/students` | List all student profiles |
| GET `/api/students/:code` | One profile by Student ID |
| GET `/api/students/:code/health` | Real health state per metric |
| POST `/api/students/enroll` | Register new student |
| POST `/api/sessions` / `POST /api/sessions/end` | Monitoring session lifecycle |
| GET/POST `/api/measurements` | List / ingest validated readings |

## Security Notes

- Health values are never fabricated: only validated real readings are stored
- Sequential Student IDs are generated exclusively by the PostgreSQL sequence
- Keep `DATABASE_URL` in environment variables; never commit `.env`
