# Project DELTA - Student Health Dashboard

A biometric health monitoring system with **human detection (YOLOv8)**, **face recognition (face-api.js)**, and **personalized vital signs dashboard**.

## Architecture

```
┌─────────────────┐     HTTP/API      ┌──────────────────┐
│  Python YOLO    │◄──────────────────►│  Node.js Server  │
│  Human Detect   │   Port 8001        │  Dashboard/API   │
│  (Camera)       │                    │  (Port 8000)     │
└────────┬────────┘                    └────────┬─────────┘
         │                                      │
         │ Human presence                       │ Serves UI + DB API
         ▼                                      ▼
┌──────────────────────────────────────────────────────────┐
│                    Browser Dashboard                      │
│  • face-api.js (face recognition + enrollment)           │
│  • Polls Python /api/human/present                       │
│  • Shows vitals only when human detected                 │
│  • Loads student profile (age/weight) on face match      │
└──────────────────────────────────────────────────────────┘
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| **Python Detector** | 8001 | YOLOv8 human detection via camera |
| **Node.js Server** | 8000 | Dashboard UI + PostgreSQL API |
| **Database** | - | Neon PostgreSQL (students, embeddings, sessions) |

## Quick Start (Local Development)

### Prerequisites
- Python 3.10+ with OpenCV, ultralytics, fastapi, uvicorn
- Node.js 18+
- Neon PostgreSQL database (set `DATABASE_URL` in `health-dashboard/server/.env`)
- Webcam

### 1. Start Python Human Detection Service
```bash
cd human-detection
pip install -r requirements.txt
python detector.py
```
- Runs on `http://localhost:8001`
- Endpoints: `/health`, `/api/human/present`, `/api/human/status`

### 2. Start Node.js Dashboard Server
```bash
cd health-dashboard/server
npm install
npm start
```
- Runs on `http://localhost:8000`
- Serves dashboard at `/`
- API: `/api/health`, `/api/student`, `/api/students/enroll`, `/api/measurements`

### 3. Open Dashboard
Navigate to **http://localhost:8000** in browser
- Allow camera permission
- Dashboard shows "NO SIGNAL" until human detected
- Stand in front of camera → YOLO detects you → vitals appear
- Unknown face → enrollment modal (name, age, weight)
- Known face → loads your personalized profile

## Raspberry Pi Deployment

### On Pi (Human Detection)
```bash
# Copy human-detection folder to Pi
scp -r human-detection pi@<pi-ip>:~/

# On Pi
cd ~/human-detection
pip install -r requirements.txt
python detector.py
```

### On Laptop/Server (Dashboard)
Update `health-dashboard/data.js`:
```javascript
const source = window.DashboardData.createPythonDetectionDataSource(
  "http://<PI_IP>:8001"  // Pi's IP address
);
```

Then serve dashboard via Node.js or deploy static files to Vercel.

## Project Structure

```
HumanDetectionPrototype/
├── human-detection/           # Python YOLO service
│   ├── detector.py           # FastAPI + YOLOv8 detection
│   ├── requirements.txt
│   └── start.bat
├── health-dashboard/         # Node.js + Browser dashboard
│   ├── server/               # Express-like Node server
│   │   ├── server.js         # Main server + API routes
│   │   ├── schema.sql        # PostgreSQL schema
│   │   └── .env              # DATABASE_URL
│   ├── index.html            # Dashboard UI
│   ├── main.js               # App logic + face recognition
│   ├── data.js               # Data source (simulated + Python polling)
│   ├── camera-monitor.js     # face-api.js integration
│   ├── db.js                 # localStorage + Neon API
│   └── styles.css
├── models/                   # face-api.js models (served locally)
└── yolov8n.pt               # YOLOv8 nano model
```

## Key Features

### Human Detection (Python)
- YOLOv8n person detection (class 0)
- Runs on separate port (8001) for isolation
- REST API for dashboard polling
- CORS enabled for cross-origin dashboard

### Face Recognition (Browser)
- face-api.js (TinyFaceDetector + FaceRecognitionNet)
- 128-dim embeddings stored in PostgreSQL
- Enrollment modal captures name, age, weight
- Local fallback via localStorage

### Dashboard Data Flow
1. Python detects human → `/api/human/present` returns `{"present": true}`
2. Dashboard polls every 1s → `setPresence(true)` → shows vitals
3. Face recognized → `setStudent({id, name, age, weightKg})`
4. Vitals simulated around baselines (configurable in `data.js`)
5. Measurements saved to PostgreSQL per session

## API Endpoints

### Python Detector (8001)
| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/health` | `{"status":"ok","service":"human-detection"}` |
| GET | `/api/human/present` | `{"present": true/false}` |
| GET | `/api/human/status` | `{"human_present":bool,"last_detection":ts,"camera_active":bool}` |

### Node.js Dashboard (8000)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Dashboard HTML |
| GET | `/api/health` | Server + DB status |
| GET | `/api/students` | All enrolled students + embeddings |
| POST | `/api/students/enroll` | `{name, embedding[128], age?, weightKg?}` |
| POST | `/api/sessions` | Start session `{clientKey, studentName}` |
| POST | `/api/measurements` | Save vitals |

## Database Schema (Neon PostgreSQL)

```sql
students (id, name, age, weight_kg, created_at)
face_embeddings (id, student_id, embedding[128], created_at)
detection_sessions (id, client_key, student_id, student_name, started_at, ended_at)
measurements (id, session_client_key, student_id, electrolytes_pct, hydration_pct, stress_pct, sodium_meq_l, lactate_mmol_l, temperature_c, recorded_at)
```

## Environment Variables

`health-dashboard/server/.env`:
```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
PORT=8000
```

## Troubleshooting

**Camera not working on Windows:**
- Detector uses camera index 1 by default (change in `detector.py`)
- Check Windows Camera Privacy Settings

**Python service not connecting:**
- Verify port 8001 accessible: `curl http://localhost:8001/health`
- Check CORS in `detector.py` (allow_origins=["*"])

**Face recognition not loading:**
- Models served from `health-dashboard/models/` (must be accessible)
- Check browser console for model load errors

## License

Internal prototype - Project DELTA