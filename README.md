# Project DELTA

**Project DELTA** is an AI-powered health and safety monitoring system designed for real-time human detection, face recognition, and health-related monitoring using computer vision.

The system combines a Raspberry Pi, camera, touchscreen dashboard, Python/OpenCV, YOLO, face recognition, Node.js, and PostgreSQL to provide a centralized monitoring experience.

---

## Features

* Real-time human detection using YOLO
* Face recognition for enrolled users
* Student/person identification
* Face embedding storage using PostgreSQL
* Real-time camera monitoring
* Health and safety monitoring dashboard
* Touchscreen-optimized interface
* Raspberry Pi deployment
* Node.js backend/API
* Python-based computer vision services
* PostgreSQL database integration

---

## System Architecture

The system is designed to run primarily on a **Raspberry Pi 4/5** connected to a camera and a 7-inch touchscreen display.

```text
                    ┌─────────────────────────┐
                    │       Camera            │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    Raspberry Pi 4/5     │
                    │                         │
                    │  Python + OpenCV        │
                    │  YOLO Human Detection   │
                    │  Face Recognition       │
                    │                         │
                    │  Node.js Server         │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │   Web Dashboard         │
                    │                         │
                    │   7" Touchscreen        │
                    │   1024 × 600            │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │     PostgreSQL          │
                    │                         │
                    │ Student/User Metadata   │
                    │ Face Embeddings         │
                    └─────────────────────────┘
```

---

## Project Structure

```text
Project-DELTA/
│
├── api/
│   └── API-related files
│
├── health-dashboard/
│   └── Dashboard frontend
│
├── human-detection/
│   └── Python human detection system
│
├── models/
│   └── AI/ML model files
│
├── server/
│   └── Node.js backend/server
│
├── .gitignore
├── README.md
└── package.json
```

> The structure above reflects the current repository organization. Update individual entries if files are moved or renamed during development.

---

## Technology Stack

### Frontend

* HTML
* CSS
* JavaScript
* Responsive web interface
* Touchscreen-optimized UI

### Backend

* Node.js
* REST API
* PostgreSQL

### Computer Vision

* Python
* OpenCV
* YOLO
* Face recognition
* Face embeddings

### Hardware

* Raspberry Pi 4 or Raspberry Pi 5
* 7-inch 1024×600 IPS capacitive touchscreen
* Camera
* MicroSD card
* Power supply
* Network connection

---

## Human Detection

The human detection module uses **YOLO** together with OpenCV to process camera frames in real time.

The detection pipeline is:

```text
Camera
   ↓
Video Frame
   ↓
OpenCV
   ↓
YOLO Detection
   ↓
Human Detection
   ↓
Detection Result
   ↓
Node.js / Dashboard
```

The detection system is designed to run locally on the Raspberry Pi.

---

## Face Recognition

Project DELTA also supports face recognition for identifying enrolled users.

The general process is:

```text
Camera
   ↓
Face Detection
   ↓
Face Encoding
   ↓
Face Embedding
   ↓
Database Comparison
   ↓
User Identification
   ↓
Dashboard
```

Face embeddings are stored in PostgreSQL and associated with the corresponding enrolled user.

For security and privacy, biometric embeddings should only be returned through protected backend endpoints when required by the application.

---

## Dashboard

The dashboard provides a centralized interface for viewing system information and detection results.

The interface is designed for a:

**7-inch 1024×600 touchscreen display**

The dashboard is developed and tested in a desktop browser first before being deployed to the Raspberry Pi.

### Display Target

```text
┌──────────────────────────────────────────┐
│              PROJECT DELTA               │
│                                          │
│   ┌──────────────────────────────────┐   │
│   │                                  │   │
│   │        Live Camera Feed          │   │
│   │                                  │   │
│   └──────────────────────────────────┘   │
│                                          │
│   Detection       Recognition            │
│   Status          Status                 │
│                                          │
│   [ Dashboard ] [ People ] [ Settings ] │
│                                          │
└──────────────────────────────────────────┘

          1024 × 600 Touchscreen
```

---

## Hardware Deployment

The intended deployment architecture is:

```text
Power ON
   ↓
Raspberry Pi boots
   ↓
Linux / Raspberry Pi OS starts
   ↓
Project DELTA services start
   ↓
Python detection service starts
   ↓
Node.js server starts
   ↓
Dashboard launches
   ↓
7" Touchscreen displays the interface
```

The Raspberry Pi acts as the primary computing device for the deployed system.

---

## Local Development

During development, the frontend, backend, and computer vision components can be tested separately on a development computer.

A typical development workflow is:

```text
Developer PC
    │
    ├── Dashboard
    ├── Node.js Server
    ├── Python Detection
    └── PostgreSQL
```

After testing, the application can be transferred and configured for Raspberry Pi deployment.

---

## Database

Project DELTA uses PostgreSQL for persistent application data.

The database may contain information such as:

* Enrolled users
* Student information
* Face embeddings
* Detection-related metadata
* System records

Sensitive biometric information should be protected through appropriate access controls and should not be unnecessarily exposed through public API responses.

---

## API

The Node.js server provides backend functionality for communication between the dashboard, detection services, and database.

Example API functionality may include:

```text
GET    /api/students
POST   /api/students
GET    /api/students/:id
POST   /api/recognition
GET    /api/detections
```

> API routes may change as development continues. Refer to the `server/` and `api/` directories for the current implementation.

---

## Raspberry Pi Setup

### 1. Install Raspberry Pi OS

Install Raspberry Pi OS on the Raspberry Pi and connect:

* Camera
* 7-inch touchscreen
* Network
* Power supply

### 2. Install Required Software

Install the required runtime environments and dependencies:

```bash
sudo apt update
sudo apt upgrade
```

Install Node.js, Python, Git, and other project dependencies required by the current implementation.

### 3. Clone the Repository

```bash
git clone <repository-url>
cd Project-DELTA
```

### 4. Install Dependencies

Install the Node.js and Python dependencies required by the project.

### 5. Configure Environment Variables

Create the required environment configuration for:

* PostgreSQL connection
* API configuration
* Application settings
* Other required credentials

Never commit secrets, passwords, database credentials, or private API keys to the repository.

### 6. Start the Services

Start the Node.js backend and Python computer vision service according to the project's current configuration.

### 7. Launch the Dashboard

The dashboard can then be displayed through the Raspberry Pi's touchscreen interface.

---

## Deployment Model

The primary deployment target is the Raspberry Pi.

```text
                    PROJECT DELTA
                         │
                         ▼
                 Raspberry Pi 4/5
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       Camera        Node.js         Dashboard
          │           Server              │
          ▼              │                ▼
     Python/OpenCV       │          7" Touchscreen
          │              │
          └───────┬──────┘
                  ▼
             PostgreSQL
```

For development, the dashboard and services may also be run on a laptop or desktop computer.

Cloud hosting platforms such as Vercel may be used for development, demonstrations, or optional web deployment, but they are not required for the core Raspberry Pi deployment.

---

## Security & Privacy

Project DELTA may process sensitive information, including facial data.

The following practices should be followed:

* Protect database credentials
* Do not commit `.env` files
* Do not expose database credentials in frontend code
* Restrict access to biometric data
* Avoid returning unnecessary face embeddings through APIs
* Use authentication and authorization for protected endpoints
* Store only the information required by the application
* Secure communication between system components when deployed over a network

---

## Development Status

Project DELTA is currently under active development.

Current development areas include:

* [x] Human detection
* [x] Face recognition
* [x] PostgreSQL integration
* [x] Web dashboard
* [x] Node.js backend
* [ ] Raspberry Pi deployment
* [ ] Touchscreen optimization
* [ ] Automatic service startup
* [ ] Production security hardening
* [ ] Full hardware integration

---

## Future Improvements

Planned improvements may include:

* Improved detection accuracy
* Better face recognition performance
* Optimized Raspberry Pi inference
* Offline-first operation
* Automatic application startup
* System health monitoring
* Detection history
* Improved touchscreen UX
* User management
* Advanced health monitoring features
* Hardware sensor integration

---

## License

This project is currently intended for educational and development purposes.

Add the appropriate license here if the project is later released as open source.
