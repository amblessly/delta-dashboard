# Project DELTA — Student Health Dashboard

A biometric student health monitoring system combining **YOLOv8 human detection**, **Python-based face recognition (InsightFace)**, **student profiles**, and a personalized health dashboard.

Project DELTA is designed to run with a **Raspberry Pi camera + Python detection service** while the dashboard and database can run separately on a laptop, local server, or hosted environment.

---

## Table of Contents

* [Overview](#overview)
* [System Architecture](#system-architecture)
* [How the System Works](#how-the-system-works)
* [Project Structure](#project-structure)
* [Requirements](#requirements)
* [Local Development](#local-development)
* [Running the Complete System](#running-the-complete-system)
* [Face Recognition Setup](#face-recognition-setup)
* [Database Setup](#database-setup)
* [API Endpoints](#api-endpoints)
* [Troubleshooting](#troubleshooting)
* [Security Notes](#security-notes)
* [License](#license)

---

# Overview

Project DELTA is a student health monitoring prototype that combines:

* YOLOv8 human detection
* InsightFace-based face recognition (Python backend)
* Student enrollment with face embedding capture
* Age and weight-based student profiles
* Personalized health dashboard
* PostgreSQL database using Neon
* Session tracking
* Vital-sign measurements

The system uses a **Python backend** for face detection and recognition, which processes camera frames sent from the browser and returns face matching results.

---

# System Architecture

```text
                         ┌──────────────────────────┐
                         │       Neon PostgreSQL     │
                         │                          │
                         │ students                 │
                         │ face_embeddings          │
                         │ detection_sessions       │
                         │ measurements             │
                         └────────────▲─────────────┘
                                      │
                                      │ PostgreSQL
                                      │
                         ┌────────────┴─────────────┐
                         │      Node.js Server      │
                         │                          │
                         │ Dashboard + REST API     │
                         │ Port 8000                │
                         └────────────▲─────────────┘
                                      │
                                      │ HTTP
                                      │
                         ┌────────────┴─────────────┐
                         │      Web Dashboard       │
                         │                          │
                         │ Camera frames            │
                         │ Student profiles         │
                         │ Health dashboard         │
                         └────────────▲─────────────┘
                                      │
                                      │ HTTP POST
                                      │ (base64 frames)
                                      │
                         ┌────────────┴─────────────┐
                         │   Python Face Service    │
                         │                          │
                         │ InsightFace (buffalo_l)  │
                         │ Face detection + matching│
                         │ Port 8001                │
                         └──────────────────────────┘
```

---

# How the System Works

The complete flow is:

```text
1. Start Python Face Service (port 8001)
   ↓
2. Start Node.js Server (port 8000)
   ↓
3. Open Dashboard in Browser
   ↓
4. Browser requests camera access
   ↓
5. Camera frames captured every 500ms
   ↓
6. Frames sent to Python backend (POST /api/face/detect)
   ↓
7. Python detects face using InsightFace
   ↓
8. Face embedding generated (512-dimensional vector)
   ↓
9. Backend matches against enrolled students
   ↓
10. Result returned:
    - MATCHED → Load student profile
    - UNKNOWN → Show enrollment modal
    - NO_FACE → Show "NO SIGNAL"
    - UNCLEAR → Show guidance message
```

---

# Project Structure

```text
delta-dashboard/
│
├── human-detection/
│   ├── detector.py              # YOLOv8 human detection
│   ├── face_service.py          # InsightFace face recognition service
│   ├── start_face_service.bat   # Start script for face service
│   ├── requirements.txt
│   └── start.bat
│
├── health-dashboard/
│   ├── server/                  # Node.js server
│   │   ├── server.js
│   │   ├── schema.sql
│   │   └── .env
│   └── *.js, *.css, *.html     # Dashboard files
│
├── models/                      # face-api.js models (legacy)
│
├── camera-monitor.js            # Camera + face recognition logic
├── main.js                      # UI binding + state machine
├── data.js                      # Data source (simulated vitals)
├── db.js                        # Database operations
├── index.html                   # Dashboard UI
├── styles.css                   # Dashboard styles
└── README.md
```

---

# Requirements

## Software Requirements

### Python Face Service
* Python 3.10+
* pip
* virtualenv
* InsightFace
* ONNX Runtime
* OpenCV
* Flask
* Flask-CORS

### Dashboard Server
* Node.js 18+
* npm
* Neon PostgreSQL

### Browser
A modern browser with:
* JavaScript enabled
* Camera permission
* WebAssembly support

---

# Local Development

## Step 1 — Clone the Repository

```bash
git clone https://github.com/amblessly/delta-dashboard.git
cd delta-dashboard
```

---

## Step 2 — Set Up the Python Face Service

Open a terminal:

```bash
cd human-detection
```

Create a virtual environment:

```bash
python -m venv venv
```

Activate it on Windows:

```bash
venv\Scripts\activate
```

Activate it on Linux/macOS:

```bash
source venv/bin/activate
```

Install dependencies:

```bash
pip install insightface onnxruntime flask flask-cors opencv-python numpy
```

---

## Step 3 — Start the Face Recognition Service

Run:

```bash
python face_service.py
```

The service should run on:

```text
http://localhost:8001
```

Test the service:

```bash
curl http://localhost:8001/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "face-detection",
  "model_loaded": true
}
```

---

## Step 4 — Set Up the Node.js Server

Open another terminal.

From the repository root:

```bash
cd health-dashboard/server
```

Install dependencies:

```bash
npm install
```

Create the environment file:

```text
health-dashboard/server/.env
```

Add:

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
PORT=8000
```

Replace the database URL with your actual Neon PostgreSQL connection string.

---

## Step 5 — Start the Dashboard Server

Run:

```bash
npm start
```

The dashboard server should be available at:

```text
http://localhost:8000
```

Open the address in your browser.

---

# Running the Complete System

Once everything is configured, the recommended startup order is:

## 1. Start Python Face Service

```bash
cd human-detection
source venv/bin/activate
python face_service.py
```

Or use the batch script (Windows):

```bash
human-detection\start_face_service.bat
```

---

## 2. Verify Face Service

From another terminal:

```bash
curl http://localhost:8001/health
```

Expected:

```json
{
  "status": "ok",
  "service": "face-detection",
  "model_loaded": true
}
```

---

## 3. Start Node.js Dashboard

```bash
cd health-dashboard/server
npm start
```

---

## 4. Open Dashboard

Open:

```text
http://localhost:8000
```

---

## 5. Allow Camera Permission

Allow camera permission when requested by the browser.

---

# Face Recognition Setup

Project DELTA uses **InsightFace** (Python backend) for face recognition.

## How It Works

1. Browser captures camera frames every 500ms
2. Frames are sent to Python backend as base64 images
3. Python detects faces using InsightFace (buffalo_l model)
4. Face embeddings (512-dimensional vectors) are generated
5. Embeddings are compared against enrolled students
6. Match result is returned to the browser

## Face Detection Flow

```text
Camera Frame (base64)
        ↓
POST /api/face/detect
        ↓
InsightFace Detection
        ↓
Face Bounding Box + Confidence
        ↓
Face Embedding (512-d vector)
        ↓
Match Against Enrolled Students
        ↓
Return Result:
  - face_detected + embedding
  - no_face
  - multiple_faces
  - unclear (low confidence)
```

## Student Enrollment

When an unknown face is detected:

1. Enrollment modal appears
2. User enters: Name, Age, Weight
3. Face embedding is captured
4. POST /api/face/enroll is called
5. Student is saved to database
6. Student is added to local cache
7. Recognition works immediately

---

# Database Setup

Project DELTA uses Neon PostgreSQL.

The database stores student profiles, face embeddings, sessions, and measurements.

## Database Tables

### students

```text
id            SERIAL PRIMARY KEY
name          VARCHAR(120)
age           INTEGER
weight_kg     DECIMAL(5,1)
created_at    TIMESTAMP DEFAULT NOW()
```

### face_embeddings

```text
id            SERIAL PRIMARY KEY
student_id    INTEGER REFERENCES students(id)
embedding     FLOAT8[] (128-dimensional)
created_at    TIMESTAMP DEFAULT NOW()
```

### detection_sessions

```text
id            SERIAL PRIMARY KEY
client_key    VARCHAR(64) UNIQUE
student_id    INTEGER REFERENCES students(id)
student_name  VARCHAR(120)
started_at    TIMESTAMP DEFAULT NOW()
ended_at      TIMESTAMP
```

### measurements

```text
id                    SERIAL PRIMARY KEY
session_client_key    VARCHAR(64)
student_id            INTEGER
student_name          VARCHAR(120)
electrolytes_pct      DECIMAL(5,1)
hydration_pct         DECIMAL(5,1)
stress_pct            DECIMAL(5,1)
sodium_meq_l          DECIMAL(5,1)
lactate_mmol_l        DECIMAL(5,1)
temperature_c         DECIMAL(5,1)
recorded_at           TIMESTAMP DEFAULT NOW()
```

---

# API Endpoints

## Python Face Service (Port 8001)

### Health Check

```http
GET /health
```

Response:

```json
{
  "status": "ok",
  "service": "face-detection",
  "model_loaded": true
}
```

### Detect Face

```http
POST /api/face/detect
Content-Type: application/json

{
  "image": "base64_encoded_image"
}
```

Response:

```json
{
  "status": "face_detected",
  "embedding": [0.123, -0.456, ...],
  "confidence": 0.95,
  "bbox": [100, 50, 200, 200]
}
```

### Match Face

```http
POST /api/face/match
Content-Type: application/json

{
  "embedding": [0.123, -0.456, ...]
}
```

Response:

```json
{
  "matched": true,
  "student": {
    "id": 1,
    "name": "John Doe",
    "age": 20,
    "weight_kg": 65.5,
    "photo": "base64_image"
  },
  "confidence": 0.85
}
```

### Enroll Student

```http
POST /api/face/enroll
Content-Type: application/json

{
  "name": "John Doe",
  "embedding": [0.123, -0.456, ...],
  "age": 20,
  "weight_kg": 65.5,
  "photo": "base64_image"
}
```

Response:

```json
{
  "id": 1,
  "name": "John Doe",
  "age": 20,
  "weight_kg": 65.5,
  "enrolled": true
}
```

### List Students

```http
GET /api/students
```

Response:

```json
[
  {
    "id": 1,
    "name": "John Doe",
    "age": 20,
    "weight_kg": 65.5,
    "embeddings": [[0.123, -0.456, ...]]
  }
]
```

---

## Node.js Dashboard API (Port 8000)

### Server Health

```http
GET /api/health
```

### Get Students

```http
GET /api/students
```

### Enroll Student

```http
POST /api/students/enroll
```

### Start Session

```http
POST /api/sessions
```

### Save Measurement

```http
POST /api/measurements
```

---

# Troubleshooting

## Python Face Service Not Starting

Check Python version:

```bash
python --version
```

Check installed packages:

```bash
pip list | grep -E "insightface|onnxruntime|flask"
```

Reinstall dependencies:

```bash
pip install insightface onnxruntime flask flask-cors opencv-python numpy
```

---

## Face Detection Not Working

1. Check if face service is running:

```bash
curl http://localhost:8001/health
```

2. Check browser console for CORS errors

3. Verify camera permission is granted

4. Check if InsightFace model downloaded:

```text
C:\Users\<username>/.insightface/models/buffalo_l/
```

---

## Dashboard Shows "NO SIGNAL"

Check the following:

```text
Dashboard
    ↓
Python Face Service (port 8001)
    ↓
InsightFace Model
    ↓
Camera
```

Test manually:

```bash
curl http://localhost:8001/health
```

If the endpoint returns `model_loaded: false`, the InsightFace model needs to be downloaded.

---

## Face Recognition Not Matching

1. Ensure student is enrolled:

```bash
curl http://localhost:8001/api/students
```

2. Check embedding dimensions (should be 128-dimensional for face-api.js compatibility or 512-dimensional for InsightFace)

3. Lower match threshold if needed (currently 0.6 cosine similarity)

---

## Database Connection Problems

Check:

```text
health-dashboard/server/.env
```

Make sure:

```env
DATABASE_URL=...
```

is configured correctly.

Do not commit `.env` to GitHub.

---

# Security Notes

This project is currently an internal prototype.

Before production deployment:

* Do not expose port `8001` directly to the public internet.
* Do not commit database credentials.
* Use environment variables for secrets.
* Restrict database access.
* Use HTTPS for production traffic.
* Add authentication/authorization to sensitive API endpoints.
* Restrict CORS origins instead of allowing all origins.
* Protect student biometric data.
* Review data retention requirements.
* Avoid exposing face embeddings through public endpoints.

---

# License

Internal prototype — Project DELTA.

This project is intended for educational, research, and prototype development purposes.
