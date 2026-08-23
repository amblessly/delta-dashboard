# Project DELTA — Student Health Dashboard

Biometric student health monitoring dashboard built for a Raspberry Pi
kiosk. The camera watches for the user's face — when detected, live
health readings appear and every measurement is stored in a Neon
PostgreSQL database. No face on camera means everything reads zero.

```
Camera ──► face detection ──► FACE DETECTED  → baseline readings + recommendations → saved to PostgreSQL (Neon cloud)
                          └──► NO FACE       → all values 0 · STANDBY · "NO SIGNAL"
```

## Features

- **Face-detection gate** — readings only appear while a face is visible;
  look away and the dashboard drops to `0 / STANDBY` automatically
- **Live avatar feed** — your face appears in the profile circle with a
  scanning animation; green ring once detected
- **Event-driven values** — each new detection session starts from fresh
  baseline readings (no fake auto-updating numbers)
- **Recommendations engine** — hydration / stress / lactate guidance with
  tappable acknowledge actions
- **PostgreSQL storage** — sessions and measurements are written to a
  Neon cloud database through a small Node.js API server
- **Kiosk mode** — boots straight into a fullscreen dashboard on a Pi

---

## What you need (Raspberry Pi)

| Item | Notes |
|---|---|
| Raspberry Pi 4 / 5 (2 GB+) | Raspberry Pi OS **Bookworm with desktop** |
| USB webcam | Plug-and-play in Chromium. A CSI ribbon camera needs extra setup — use a USB cam for the easiest path. |
| Official 7" touchscreen (optional) | 1024×600 — the dashboard has a dedicated kiosk layout for it. Any HDMI screen works too. |
| Neon PostgreSQL account | Free tier: [neon.tech](https://neon.tech) → create project → copy connection string |
| Internet | The database is in Neon's cloud, so the Pi needs connectivity |

---

## Quick start on Raspberry Pi (4 steps)

### 1. Clone the project

```bash
cd ~
git clone https://github.com/amblessly/detla-dashboard.git
cd detla-dashboard
```

*(No git yet? `sudo apt update && sudo apt install -y git`)*

### 2. Add your database credentials

```bash
cp server/.env.example server/.env
nano server/.env
```

Paste your Neon connection string:

```ini
DATABASE_URL=postgresql://USER:PASSWORD@HOST/neondb?sslmode=require
PORT=8000
```

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

### 3. Run the installer

Installs Chromium, Node.js 20, npm packages, and creates all database
tables automatically:

```bash
bash raspberry-pi/install.sh
```

### 4. Enable boot-to-kiosk autostart, then reboot

```bash
sudo bash raspberry-pi/install-services.sh
sudo reboot
```

**That's it.** After rebooting, the Pi goes straight into the fullscreen
dashboard: camera permission is granted automatically, face detection is
live, and measurements start saving to PostgreSQL the moment someone
looks at the camera.

---

## Manual run (no autostart)

Useful for testing or running on a regular PC:

```bash
cd server
npm install        # first time only
npm start          # serves dashboard + API at http://localhost:8000
```

Open <http://localhost:8000> in Chrome/Chromium, allow the camera, and
face the webcam.

> Camera access requires `localhost` or HTTPS — opening `index.html`
> directly from disk will not work.

---

## Autostart services (what gets installed)

| Service | Purpose |
|---|---|
| `delta-server.service` | Runs the Node.js API server (`server/server.js`) on port 8000, restarts on crash |
| `delta-kiosk.service` | Launches Chromium in fullscreen kiosk mode pointing at `localhost:8000`, with the camera permission prompt auto-accepted |

Manage them any time:

```bash
systemctl status delta-server delta-kiosk   # check state
sudo systemctl restart delta-server         # restart API
journalctl -u delta-server -f               # live logs
sudo systemctl disable --now delta-kiosk delta-server   # remove autostart
```

---

## Database (Neon PostgreSQL)

Three tables mirror exactly what the dashboard shows:

| `students` | name, age, weight_kg | Dashboard patient profile |
| `detection_sessions` | client_key, **student_id**, student_name, started_at, ended_at | One row per face-detection period |
| `measurements` | **student_id**, student_name, electrolytes_pct, hydration_pct, stress_pct, sodium_meq_l, lactate_mmol_l, temperature_c, recorded_at | One row per periodic reading (every 10 s while a face is present) |
| `face_embeddings` | student_id, **embedding (float[] 128)** | Facial recognition enrollment vectors |

Re-apply the schema anytime with `cd server && npm run setup-db`.
Inspect data via the Neon SQL console or:

```bash
curl http://localhost:8000/api/measurements?limit=10
```

API endpoints served by `server.js`:
`GET /api/health` · `GET /api/students` · `GET /api/measurements?limit=N`
`POST /api/sessions` · `POST /api/sessions/end` · `POST /api/measurements`
`POST /api/students/enroll`

---

## How it works (facial recognition)

1. On boot, Chromium opens `http://localhost:8000`; the page requests the
   camera (permission is pre-granted by the kiosk flags).
2. `camera-monitor.js` loads face-api.js models (TinyFaceDetector +
   FaceLandmark68Tiny + FaceRecognitionNet) which run in-browser via
   WASM/JS on the Pi — no Python or server-side processing needed.
3. Every ~900 ms a frame is analyzed:
   - Face detected → 128-dimensional embedding extracted
   - Compared vs enrolled embeddings using Euclidean distance
   - Distance < 0.5 → **IDENTIFIED** (known student → dashboard shows
     that student's data automatically)
   - No match → **UNKNOWN** → enrollment modal pops up:
     *"NEW STUDENT DETECTED — Enter name"*
   - No face at all → **NO SIGNAL**, dashboard shows zeros
4. Enrollment saves the face embedding in the Neon database alongside
   the student profile. Next time that face appears, it is automatically
   recognized.
5. Each detection session and periodic measurement is written to Neon
   PostgreSQL (with the correct student_id) plus a localStorage fallback.

---

## Project structure

```
index.html            dashboard layout (1024x600 kiosk grid + responsive)
styles.css            dark biometric-terminal theme
main.js               rendering, wiring of camera monitor + database
data.js               data layer: presence gate, baselines, rec engine
camera-monitor.js     getUserMedia + face-presence heuristic
db.js                 dual-write storage (Neon API + localStorage fallback)
server/
  server.js           static file server + JSON API (Node pg -> Neon)
  schema.sql          database tables
  setup-db.js         applies schema + seeds student profile
  .env.example        template for DATABASE_URL / PORT
raspberry-pi/
  install.sh          system deps + Node + npm + DB schema
  install-services.sh systemd autostart (API + kiosk browser)
face-api.min.js         face-api.js WASM library (offline)
models/                 face-api.js model weights (3 models)
face-api.min.js         face-api.js WASM library (offline)
models/                 face-api.js model weights (3 models)
strip-analysis.js       colorimetric strip pipeline (dormant module)
calibration.js          strip calibration store (dormant)
device.js               strip device state machine (dormant)
device-panel.js         strip device UI wiring (dormant)
HEAT-STRESS.md        heat-stress formula documentation
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Camera prompt never appears / black circle | Use `http://localhost:8000` (not `file://`). Check the webcam works: `ls /dev/video*`. Replug the USB camera. |
| Everything stays at 0 even with a face | Improve lighting. The heuristic needs reasonable skin-tone contrast — adjust thresholds in `camera-monitor.js` (`SKIN_RATIO_MIN`, `BRIGHTNESS_MIN`). |
| `/api/health` returns error | Check `server/.env`, then test the connection string: `cd server && npm run setup-db`. Verify internet access on the Pi. |
| Port 8000 already in use | Change `PORT=` in `server/.env`, then `sudo systemctl restart delta-server`. |
| Kiosk shows blank after reboot | Wait ~15 s for the server unit, then `journalctl -u delta-kiosk -f`. Confirm you ran both install scripts. |
| Wrong screen resolution | Preferences → Screen Configuration → set 1024×600 for the official 7" display. |

---

## Security notes

- `server/.env` holds the database credentials and is **never committed**
  (see `.gitignore`). Copy `.env.example` and fill in your own.
- Rotate your Neon password if it was ever shared in plain text
  (Neon console → Roles → Reset password), then update `.env` and
  restart the service.
- The dashboard reports face **presence**, not identity — no biometric
  identification data is stored.
