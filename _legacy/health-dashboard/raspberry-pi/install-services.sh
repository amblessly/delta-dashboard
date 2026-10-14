#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Project DELTA dashboard - Raspberry Pi installer (step 2 of 2)
# Installs systemd services so the dashboard starts automatically on
# boot: API server + Chromium kiosk pointing at it, with camera
# permission auto-granted. Fully "ready to use" after reboot.
#
# Usage:  sudo bash raspberry-pi/install-services.sh && sudo reboot
# ---------------------------------------------------------------------
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
APP_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node)"
BROWSER="$(command -v chromium-browser || command -v chromium)"

if [ -z "$BROWSER" ]; then
  echo "ERROR: chromium not found. Run install.sh first." >&2
  exit 1
fi

echo "==> Installing autostart services"
echo "    user:   $APP_USER"
echo "    node:   $NODE_BIN"
echo "    browser:$BROWSER"

# 1) API server service -------------------------------------------------
sudo tee /etc/systemd/system/delta-server.service >/dev/null <<EOF
[Unit]
Description=Project DELTA dashboard server (Neon DB API)
Wants=network-online.target
After=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 2) Kiosk browser service ---------------------------------------------
sudo tee /etc/systemd/system/delta-kiosk.service >/dev/null <<EOF
[Unit]
Description=Project DELTA dashboard kiosk (Chromium fullscreen)
Requires=delta-server.service
After=delta-server.service graphical.target

[Service]
User=$APP_USER
Environment=DISPLAY=:0
ExecStart=$BROWSER \\
  --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
  --disable-features=Translate,MediaRouter \\
  --autoplay-policy=no-user-gesture-required \\
  --use-fake-ui-for-media-stream \\
  --check-for-update-interval=31536000 \\
  http://localhost:8000
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable delta-server.service delta-kiosk.service

cat <<EOF

===============================================================
 Autostart installed!

   delta-server.service -> API on http://localhost:8000
   delta-kiosk.service  -> Chromium fullscreen kiosk

 Finish with:   sudo reboot
 Remove later:  sudo systemctl disable --now delta-kiosk delta-server
===============================================================
EOF
