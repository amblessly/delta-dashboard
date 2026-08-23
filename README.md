# Project DELTA — Student Health Dashboard

A biometric student health monitoring system combining **YOLOv8 human detection**, **face recognition**, **student profiles**, and a personalized health dashboard.

Project DELTA is designed to run with a **Raspberry Pi camera + Python detection service** while the dashboard and database can run separately on a laptop, local server, or hosted environment.

---

## Table of Contents

* [Overview](#overview)
* [System Architecture](#system-architecture)
* [How the System Works](#how-the-system-works)
* [Project Structure](#project-structure)
* [Requirements](#requirements)
* [Local Development](#local-development)
* [Raspberry Pi Deployment](#raspberry-pi-deployment)
* [Connecting Raspberry Pi to the Dashboard](#connecting-raspberry-pi-to-the-dashboard)
* [Database Setup](#database-setup)
* [Face Recognition Setup](#face-recognition-setup)
* [Running the Complete System](#running-the-complete-system)
* [Auto-Start on Raspberry Pi Boot](#auto-start-on-raspberry-pi-boot)
* [API Endpoints](#api-endpoints)
* [Network Configuration](#network-configuration)
* [Troubleshooting](#troubleshooting)
* [Security Notes](#security-notes)
* [License](#license)

---

# Overview

Project DELTA is a student health monitoring prototype that combines:

* YOLOv8 human detection
* Raspberry Pi camera monitoring
* Browser-based face recognition
* Student enrollment
* Age and weight-based student profiles
* Personalized health dashboard
* PostgreSQL database using Neon
* Session tracking
* Vital-sign measurements
* Raspberry Pi deployment

The system separates **human detection** from the dashboard.

The Raspberry Pi handles the camera and YOLOv8 detection, while the dashboard communicates with the Raspberry Pi through HTTP.

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
                         │ face-api.js              │
                         │ Student profiles         │
                         │ Health dashboard         │
                         └────────────▲─────────────┘
                                      │
                                      │
                              /api/human/present
                                      │
                                      │ LAN
                                      ▼
                    ┌──────────────────────────────────┐
                    │          Raspberry Pi             │
                    │                                  │
                    │  Python + FastAPI                │
                    │  YOLOv8 Human Detection          │
                    │  Port 8001                       │
                    │                                  │
                    │          Camera                  │
                    └──────────────────────────────────┘
```

---

# How the System Works

The complete flow is:

```text
Raspberry Pi boots
        ↓
Python detection service starts
        ↓
Camera starts
        ↓
YOLOv8 detects people
        ↓
Detection API becomes available
        ↓
Dashboard connects to Raspberry Pi
        ↓
Dashboard polls /api/human/present
        ↓
Human detected
        ↓
Face recognition runs in browser
        ↓
Known face?
     /       \
   YES       NO
    ↓         ↓
Load       Enrollment
profile      modal
    ↓         ↓
    └────┬────┘
         ↓
Student profile loaded
         ↓
Personalized dashboard displayed
         ↓
Measurements saved to Neon PostgreSQL
```

---

# Project Structure

The repository currently uses the following structure:

```text
delta-dashboard/
│
├── api/
│
├── health-dashboard/
│
├── human-detection/
│   ├── detector.py
│   ├── requirements.txt
│   └── start.bat
│
├── models/
│   └── face-api.js models
│
├── raspberry-pi/
│
├── server/
│   ├── server.js
│   ├── schema.sql
│   └── .env
│
├── .gitignore
├── HEAT-STRESS.md
├── calibration.js
├── camera-monitor.js
├── data.js
├── db.js
├── device-panel.js
├── device.js
├── face-api.min.js
├── index.html
├── main.js
├── strip-analysis.js
├── styles.css
└── vercel.json
```

> Keep this section updated whenever the repository structure changes.

---

# Requirements

## Hardware

### Minimum

* Raspberry Pi 4 or Raspberry Pi 5
* Raspberry Pi-compatible camera or USB webcam
* MicroSD card
* Power supply
* Network connection
* Laptop/desktop for development and dashboard hosting

### Recommended

* Raspberry Pi 5
* 4GB RAM or higher
* Raspberry Pi Camera Module or compatible USB camera
* Stable Wi-Fi or Ethernet connection
* Active cooling

---

# Software Requirements

## Raspberry Pi

* Raspberry Pi OS
* Python 3.10+
* pip
* virtualenv
* OpenCV
* Ultralytics
* FastAPI
* Uvicorn

## Dashboard Server

* Node.js 18+
* npm
* Neon PostgreSQL

## Browser

A modern browser with:

* JavaScript enabled
* Camera permission
* WebAssembly support

---

# Local Development

Local development allows you to test the system before deploying it to the Raspberry Pi.

---

## Step 1 — Clone the Repository

```bash
git clone https://github.com/amblessly/delta-dashboard.git
cd delta-dashboard
```

---

# Step 2 — Set Up the Python Detection Service

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
pip install -r requirements.txt
```

---

# Step 3 — Start the Human Detection Service

Run:

```bash
python detector.py
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
  "service": "human-detection"
}
```

---

# Step 4 — Set Up the Node.js Server

Open another terminal.

From the repository root:

```bash
cd server
```

Install dependencies:

```bash
npm install
```

Create the environment file:

```text
server/.env
```

Add:

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
PORT=8000
```

Replace the database URL with your actual Neon PostgreSQL connection string.

---

# Step 5 — Start the Dashboard Server

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

# Raspberry Pi Deployment

This section explains how to move the human-detection system from your computer to a Raspberry Pi.

The Raspberry Pi does **not** need to run the entire dashboard.

The recommended setup is:

```text
Raspberry Pi
    ↓
Camera
    ↓
Python + YOLOv8
    ↓
Port 8001
```

while the dashboard can remain on your laptop/server:

```text
Laptop / Server
    ↓
Node.js
    ↓
Port 8000
    ↓
Dashboard
```

Both devices communicate over the same network.

---

# Step 1 — Prepare the Raspberry Pi

Boot the Raspberry Pi and connect it to the network.

Update the operating system:

```bash
sudo apt update
sudo apt upgrade -y
```

Check Python:

```bash
python3 --version
```

Check pip:

```bash
pip3 --version
```

---

# Step 2 — Test the Camera

For a Raspberry Pi camera, test the camera using the appropriate Raspberry Pi camera utility.

For example:

```bash
libcamera-hello
```

If you are using a USB webcam, check connected devices:

```bash
ls /dev/video*
```

You should see something similar to:

```text
/dev/video0
```

If the camera is not detected, verify the camera connection before continuing.

---

# Step 3 — Find the Raspberry Pi IP Address

On the Raspberry Pi:

```bash
hostname -I
```

Example:

```text
192.168.1.105
```

This IP address will be used by the dashboard to communicate with the Raspberry Pi.

Save this IP address.

---

# Step 4 — Copy the Human Detection Folder to the Raspberry Pi

From your development computer:

```bash
scp -r human-detection pi@<PI_IP>:~/
```

Example:

```bash
scp -r human-detection pi@192.168.1.105:~/
```

Enter the Raspberry Pi password when requested.

After copying, the Raspberry Pi should contain:

```text
/home/pi/human-detection/
```

---

# Step 5 — Open the Human Detection Folder

On the Raspberry Pi:

```bash
cd ~/human-detection
```

Check the files:

```bash
ls
```

You should see files such as:

```text
detector.py
requirements.txt
start.bat
```

---

# Step 6 — Create a Python Virtual Environment

Run:

```bash
python3 -m venv venv
```

Activate it:

```bash
source venv/bin/activate
```

Your terminal should now indicate that the virtual environment is active.

---

# Step 7 — Upgrade pip

```bash
pip install --upgrade pip
```

---

# Step 8 — Install Python Dependencies

Run:

```bash
pip install -r requirements.txt
```

This installs the dependencies required by the human detection service.

Depending on the Raspberry Pi model and operating system, installing computer-vision dependencies may take some time.

---

# Step 9 — Configure the Camera

Open the detector:

```bash
nano detector.py
```

Check the camera configuration.

If the application uses a camera index, you may see something similar to:

```python
cv2.VideoCapture(0)
```

For another camera device, this may need to be changed:

```python
cv2.VideoCapture(1)
```

Use the camera device that is actually available on your Raspberry Pi.

Save the file after making changes.

---

# Step 10 — Start the Detection Service

Run:

```bash
source ~/human-detection/venv/bin/activate
python detector.py
```

The service should start on:

```text
http://0.0.0.0:8001
```

This means the service can be accessed through the Raspberry Pi's network address.

---

# Step 11 — Test the Raspberry Pi API

On the Raspberry Pi:

```bash
curl http://localhost:8001/health
```

Expected:

```json
{
  "status": "ok",
  "service": "human-detection"
}
```

Now test from your laptop.

If the Pi IP is:

```text
192.168.1.105
```

run:

```bash
curl http://192.168.1.105:8001/health
```

If this works, your laptop can communicate with the Raspberry Pi.

---

# Step 12 — Test Human Detection

Open:

```text
http://192.168.1.105:8001/api/human/present
```

Expected response:

```json
{
  "present": true
}
```

when a person is detected.

Without a person:

```json
{
  "present": false
}
```

---

# Connecting Raspberry Pi to the Dashboard

Once the Raspberry Pi detection service works, connect it to the dashboard.

---

# Step 1 — Find the Current Detection URL

The dashboard uses the Python detection service through a data source.

You may have code similar to:

```javascript
window.DashboardData.createPythonDetectionDataSource(
  "http://localhost:8001"
);
```

`localhost` means the same machine running the browser/server.

When the detector moves to the Raspberry Pi, this must point to the Raspberry Pi.

---

# Step 2 — Change the Detection Server Address

Example:

```javascript
window.DashboardData.createPythonDetectionDataSource(
  "http://192.168.1.105:8001"
);
```

Replace:

```text
192.168.1.105
```

with your Raspberry Pi's actual IP address.

---

# Step 3 — Start the Dashboard

On the laptop/server:

```bash
cd server
npm start
```

Open:

```text
http://localhost:8000
```

---

# Step 4 — Verify the Connection

The browser should communicate with:

```text
Laptop
   ↓
Dashboard
   ↓
http://192.168.1.105:8001
   ↓
Raspberry Pi
   ↓
YOLOv8
   ↓
Camera
```

The dashboard should change from:

```text
NO SIGNAL
```

to the appropriate detection state when a human is detected.

---

# Database Setup

Project DELTA uses Neon PostgreSQL.

The database stores student profiles, face embeddings, sessions, and measurements.

---

# Database Tables

The current schema includes:

### students

Stores student profile information.

```text
id
name
age
weight_kg
created_at
```

### face_embeddings

Stores the student's face embedding.

```text
id
student_id
embedding
created_at
```

### detection_sessions

Stores detection sessions.

```text
id
client_key
student_id
student_name
started_at
ended_at
```

### measurements

Stores recorded measurements.

```text
id
session_client_key
student_id
electrolytes_pct
hydration_pct
stress_pct
sodium_meq_l
lactate_mmol_l
temperature_c
recorded_at
```

---

# Configure the Database

Inside:

```text
server/.env
```

add:

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

Do not commit the real database connection string to GitHub.

Make sure `.env` is included in `.gitignore`.

---

# Face Recognition Setup

Project DELTA uses `face-api.js` for browser-based face recognition.

The browser loads the required models from the local model directory.

The model files must be accessible to the dashboard.

Expected model location:

```text
models/
```

If face recognition does not work, check the browser developer console for model-loading errors.

---

# Student Enrollment

When an unknown face is detected, the dashboard can display the enrollment interface.

The enrollment information includes:

```text
Name
Age
Weight
Face embedding
```

The face embedding is generated by face-api.js.

The dashboard sends the enrollment information to:

```text
POST /api/students/enroll
```

---

# Student Recognition

For a known student:

```text
Camera
   ↓
Human detected
   ↓
Face detected
   ↓
Face embedding generated
   ↓
Embedding compared with enrolled students
   ↓
Student matched
   ↓
Student profile loaded
```

The student's profile can then be used by the dashboard for personalized information.

---

# Running the Complete System

Once everything is configured, the recommended startup order is:

## 1. Start Raspberry Pi

Power on the Raspberry Pi.

Start the detection service:

```bash
cd ~/human-detection
source venv/bin/activate
python detector.py
```

---

## 2. Verify Raspberry Pi

From the laptop:

```bash
curl http://<PI_IP>:8001/health
```

Example:

```bash
curl http://192.168.1.105:8001/health
```

---

## 3. Start Node.js Dashboard

On the laptop/server:

```bash
cd server
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

Allow camera permission if requested by the browser.

The camera used for YOLO human detection should be connected to the Raspberry Pi.

The browser camera is used by face-api.js for face recognition/enrollment when applicable.

---

# Complete Production Flow

```text
                    POWER ON
                       │
                       ▼
               Raspberry Pi boots
                       │
                       ▼
             Python service starts
                       │
                       ▼
                Camera initializes
                       │
                       ▼
                 YOLOv8 starts
                       │
                       ▼
                  Port :8001
                       │
                       │
                       │ LAN
                       ▼
             Node.js Dashboard :8000
                       │
                       ▼
                 Web Browser
                       │
                       ▼
              Human detected?
                  /        \
                NO          YES
                │             │
                ▼             ▼
             NO SIGNAL    Face Recognition
                              │
                         ┌────┴────┐
                         │         │
                       Known     Unknown
                         │         │
                         ▼         ▼
                      Profile   Enrollment
                         │         │
                         └────┬────┘
                              ▼
                     Personalized Data
                              │
                              ▼
                       Neon PostgreSQL
```

---

# Auto-Start on Raspberry Pi Boot

For deployment, you should configure the detection service to automatically start whenever the Raspberry Pi boots.

This prevents you from manually running:

```bash
python detector.py
```

every time.

---

# Step 1 — Create a systemd Service

On the Raspberry Pi:

```bash
sudo nano /etc/systemd/system/delta-detector.service
```

Add:

```ini
[Unit]
Description=Project DELTA Human Detection Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/human-detection
ExecStart=/home/pi/human-detection/venv/bin/python detector.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> If your Raspberry Pi username is not `pi`, replace `User=pi` and `/home/pi/` with the correct username and home directory.

---

# Step 2 — Reload systemd

```bash
sudo systemctl daemon-reload
```

---

# Step 3 — Enable the Service

```bash
sudo systemctl enable delta-detector
```

---

# Step 4 — Start the Service

```bash
sudo systemctl start delta-detector
```

---

# Step 5 — Check the Service

```bash
sudo systemctl status delta-detector
```

You should see:

```text
Active: active (running)
```

---

# Step 6 — View Logs

To monitor the service:

```bash
journalctl -u delta-detector -f
```

Press:

```text
CTRL + C
```

to exit the log viewer.

---

# Step 7 — Test Automatic Startup

Reboot the Raspberry Pi:

```bash
sudo reboot
```

Wait for it to boot.

Then from another computer:

```bash
curl http://<PI_IP>:8001/health
```

If the API responds successfully without manually starting Python, automatic startup is working.

---

# Network Configuration

The Raspberry Pi and dashboard server must be able to communicate over the network.

Recommended setup:

```text
                    Router
                  /       \
                 /         \
                ▼           ▼
        Raspberry Pi      Laptop
        192.168.1.105     192.168.1.100
             │                 │
             │                 │
             └────── LAN ──────┘
```

The dashboard uses:

```text
http://192.168.1.105:8001
```

to communicate with the Raspberry Pi.

---

# Finding the Laptop IP

On Windows:

```cmd
ipconfig
```

Look for:

```text
IPv4 Address
```

On Linux:

```bash
hostname -I
```

---

# Finding the Raspberry Pi IP

On Raspberry Pi:

```bash
hostname -I
```

Example:

```text
192.168.1.105
```

---

# Important Network Requirement

The Raspberry Pi and the dashboard server should normally be connected to the same local network.

For example:

```text
Raspberry Pi
192.168.1.105

Laptop
192.168.1.100
```

Both belong to:

```text
192.168.1.x
```

---

# API Endpoints

## Python Human Detection Service

Runs on:

```text
Port 8001
```

### Health

```http
GET /health
```

Response:

```json
{
  "status": "ok",
  "service": "human-detection"
}
```

### Human Presence

```http
GET /api/human/present
```

Response:

```json
{
  "present": true
}
```

### Human Status

```http
GET /api/human/status
```

Example:

```json
{
  "human_present": true,
  "last_detection": "timestamp",
  "camera_active": true
}
```

---

# Node.js Dashboard API

Runs on:

```text
Port 8000
```

### Dashboard

```http
GET /
```

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

Example request:

```json
{
  "name": "Student Name",
  "embedding": [128],
  "age": 18,
  "weightKg": 55
}
```

### Start Session

```http
POST /api/sessions
```

Example:

```json
{
  "clientKey": "client-001",
  "studentName": "Student Name"
}
```

### Save Measurement

```http
POST /api/measurements
```

Stores health measurements associated with the active session and student.

---

# Troubleshooting

## Raspberry Pi API is not accessible

Check whether the service is running:

```bash
sudo systemctl status delta-detector
```

Or manually:

```bash
cd ~/human-detection
source venv/bin/activate
python detector.py
```

Test locally:

```bash
curl http://localhost:8001/health
```

Then test through the Pi IP:

```bash
curl http://<PI_IP>:8001/health
```

---

# Camera Not Detected

Check:

```bash
ls /dev/video*
```

For Raspberry Pi camera hardware, verify the camera using the appropriate camera utility.

Also check:

* Camera cable
* USB connection
* Camera permissions
* Camera index in `detector.py`
* Whether another application is using the camera

---

# YOLOv8 Is Not Starting

Check Python:

```bash
python3 --version
```

Activate the virtual environment:

```bash
source ~/human-detection/venv/bin/activate
```

Check installed packages:

```bash
pip list
```

Reinstall dependencies:

```bash
pip install -r requirements.txt
```

---

# Dashboard Cannot Connect to Raspberry Pi

First test:

```bash
curl http://<PI_IP>:8001/health
```

If this fails:

1. Check the Pi IP address.
2. Check that the Pi is online.
3. Check that the Python service is running.
4. Check that both devices are on the same network.
5. Check firewall/network restrictions.
6. Check that the Python server is listening on the correct interface.

The Python service should be accessible beyond:

```text
localhost
```

when remote devices need to connect.

---

# Dashboard Shows "NO SIGNAL"

Check the following:

```text
Dashboard
    ↓
Python API URL
    ↓
Raspberry Pi IP
    ↓
Port 8001
    ↓
Human detection service
    ↓
Camera
```

Test manually:

```bash
curl http://<PI_IP>:8001/api/human/present
```

If the endpoint returns:

```json
{
  "present": true
}
```

but the dashboard still shows `NO SIGNAL`, check the browser console and dashboard data-source configuration.

---

# Face Recognition Not Loading

Check that the face-api.js models exist in the expected directory:

```text
models/
```

Open the browser developer console and look for model-loading errors.

Make sure the model paths used by the application match the actual location of the model files.

---

# Database Connection Problems

Check:

```text
server/.env
```

Make sure:

```env
DATABASE_URL=...
```

is configured correctly.

Do not commit `.env` to GitHub.

Test the server:

```text
GET /api/health
```

The response should indicate whether the server and database are available.

---

# Raspberry Pi Service Keeps Restarting

View logs:

```bash
journalctl -u delta-detector -n 100
```

Follow live logs:

```bash
journalctl -u delta-detector -f
```

Common causes:

* Camera unavailable
* Missing Python dependency
* Incorrect camera index
* Incorrect working directory
* Incorrect virtual-environment path
* Permission problem
* YOLO model loading error
* Insufficient Raspberry Pi resources

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
* Secure the Raspberry Pi with a strong password.
* Keep Raspberry Pi OS and dependencies updated.

---

# Deployment Checklist

Use this checklist when deploying Project DELTA to a new Raspberry Pi.

* [ ] Raspberry Pi OS installed
* [ ] Raspberry Pi connected to network
* [ ] Camera connected
* [ ] Camera tested
* [ ] Python 3 installed
* [ ] `human-detection/` copied to Raspberry Pi
* [ ] Python virtual environment created
* [ ] Python dependencies installed
* [ ] Camera index configured
* [ ] YOLOv8 detection tested
* [ ] Port `8001` accessible
* [ ] Raspberry Pi IP recorded
* [ ] Dashboard detection URL updated
* [ ] Node.js server configured
* [ ] Neon `DATABASE_URL` configured
* [ ] Face-api.js models available
* [ ] Dashboard tested
* [ ] Human detection tested
* [ ] Face enrollment tested
* [ ] Student recognition tested
* [ ] Measurements tested
* [ ] `systemd` service created
* [ ] `systemd` service enabled
* [ ] Raspberry Pi reboot tested
* [ ] Complete system tested

---

# Quick Deployment Summary

For future deployments, the shortest version is:

```bash
# Raspberry Pi

sudo apt update
sudo apt upgrade -y

git clone https://github.com/amblessly/delta-dashboard.git
cd delta-dashboard/human-detection

python3 -m venv venv
source venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt

python detector.py
```

Find the Pi IP:

```bash
hostname -I
```

Test:

```bash
curl http://<PI_IP>:8001/health
```

Then configure the dashboard to use:

```text
http://<PI_IP>:8001
```

Start the dashboard server:

```bash
cd server
npm install
npm start
```

Open:

```text
http://localhost:8000
```

For permanent deployment, configure the Raspberry Pi detection service with `systemd` so it automatically starts after reboot.

---

# Final Architecture

The final recommended deployment is:

```text
┌─────────────────────────────────────────────────────────┐
│                     PROJECT DELTA                       │
└─────────────────────────────────────────────────────────┘

                         INTERNET
                            │
                            ▼
                    ┌───────────────┐
                    │   Neon DB     │
                    │  PostgreSQL   │
                    └───────▲───────┘
                            │
                            │
                    ┌───────┴───────┐
                    │ Node.js Server │
                    │    :8000       │
                    └───────▲───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   Dashboard   │
                    │   Browser UI  │
                    └───────▲───────┘
                            │
                       HTTP / LAN
                            │
                            ▼
              ┌─────────────────────────┐
              │      Raspberry Pi       │
              │                         │
              │  Python + FastAPI       │
              │  YOLOv8                 │
              │  :8001                  │
              │                         │
              │       Camera            │
              └─────────────────────────┘
```

---

# License

Internal prototype — Project DELTA.

This project is intended for educational, research, and prototype development purposes.
