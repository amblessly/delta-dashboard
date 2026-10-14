# delta-dashboard backup layout

Segregated 13 Oct 2026. Nothing was deleted; files were only grouped into folders.

| Path              | Contents                                                        |
| ----------------- | --------------------------------------------------------------- |
| `.` (root)        | Live dashboard web app (index.html, main.js, styles.css, api-client.js, panel JS, db.js, data.js, fonts/, api/, colorimetric/, server/) |
| `_legacy/`        | `health-dashboard/` — older duplicate dashboard kept for reference |
| `_ml/`            | `human-detection/` — YOLOv8 detector (no venv; excluded, 4.8 GB) |
| `_pi-setup/`      | `raspberry-pi/` + deploy.py, _fix.py, test_env.sh, wvkbd-ctl.sh (first-time Pi setup) |
| `wireless-report/`| Standalone WiFi-accessible session reporting website (port 8081) |

Notes
- `server/.env` (Postgres/Neon credentials) is intentionally NOT in this backup.
- The empty 0-byte `env.example` file accidentally created during the backup pull was removed.