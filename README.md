# Project DELTA - Student Health Dashboard

Biometric student health monitoring dashboard with camera-based face
detection gating and a Neon PostgreSQL backend.

## Features

- **Face-detection gate** - values only show while a face is detected on
  the camera; no face = all zeros (NO SIGNAL / STANDBY)
- **Live avatar feed** - the user's face appears in the profile circle,
  with a scanning animation while searching
- **Event-driven readings** - fresh baseline per detection session, no
  automatic random-walk updates
- **Recommendations engine** - hydration / stress / lactate guidance with
  acknowledge actions
- **Neon PostgreSQL database** - every session and measurement is stored
  server-side (localStorage fallback when offline)

## Run

### 1. Database setup (one time)

```bash
cd server
npm install
# put your Neon connection string in server/.env:
#   DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require
npm run setup-db
```

### 2. Start

```bash
cd server
npm start
```

Open <http://localhost:8000>, allow the camera prompt, and look at the
camera. Every 10 seconds while a face is detected, a measurement row is
written to Neon.

> Camera access requires a secure context - serve via `localhost`, do not
> open `index.html` directly from disk.

## Structure

```
index.html            dashboard layout (kiosk 1024x600 + responsive)
styles.css            dark biometric-terminal theme
main.js               rendering: metrics, recommendations, boot sequence
data.js               data layer: presence gate, baselines, rec engine
camera-monitor.js     getUserMedia + face-presence heuristic
db.js                 dual-write storage (Neon API + localStorage)
server/               Node static+API server backed by Neon PostgreSQL
strip-analysis.js     colorimetric strip image pipeline (dormant)
calibration.js        strip calibration store (dormant)
device.js             strip device state machine (dormant)
device-panel.js       strip device UI wiring (dormant)
```
