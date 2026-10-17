#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Project DELTA dashboard - Raspberry Pi installer (step 2 of 2)
# Installs systemd services so the dashboard starts automatically on
# boot: API server + Chromium kiosk pointing at it, with camera
# permission auto-granted. Fully "ready to use" after reboot.
#
# Usage:  cd _pi-setup && sudo bash raspberry-pi/install-services.sh && sudo reboot
# ---------------------------------------------------------------------
set -euo pipefail

PI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$PI_DIR/../.." && pwd)"
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

# 3) Touch calibration for portrait mode ---------------------------------
echo "==> [3/7] Installing touch calibration (portrait mode)..."
sudo cp "$PI_DIR/99-touch-calibration.rules" /etc/udev/rules.d/99-touch-rotate.rules
sudo cp "$PI_DIR/99-touch-rotate.hwdb" /etc/udev/hwdb.d/99-touch-rotate.hwdb
sudo rm -f /etc/udev/hwdb.d/91-touch-rotate.hwdb 2>/dev/null || true
sudo systemd-hwdb update
sudo udevadm control --reload-rules

# 4) labwc compositor config ---------------------------------------------
echo "==> [4/7] Installing labwc config..."
mkdir -p "$HOME/.config/labwc"
sudo cp "$PI_DIR/labwc-rc.xml" "$HOME/.config/labwc/rc.xml"
sudo cp "$PI_DIR/labwc-autostart" "$HOME/.config/labwc/autostart"
chmod +x "$HOME/.config/labwc/autostart" 2>/dev/null || true

# 5) Lightdm session-setup-script (runs udev trigger before labwc) ------
echo "==> [5/7] Installing lightdm session setup..."
sudo cp "$PI_DIR/delta-touch-setup" /usr/bin/delta-touch-setup
sudo chmod +x /usr/bin/delta-touch-setup
if ! grep -q '^session-setup-script=' /etc/lightdm/lightdm.conf; then
  echo 'session-setup-script=/usr/bin/delta-touch-setup' | sudo tee -a /etc/lightdm/lightdm.conf
fi

# 6) Camera reader service (Picamera2 + OpenCV electrolyte analysis) ----
PYTHON3="$(command -v python3)"
CAMERA_SCRIPT="$PI_DIR/camera_reader.py"
if [ -f "$CAMERA_SCRIPT" ]; then
  echo "==> [6/7] Installing camera reader service..."
  sudo tee /etc/systemd/system/delta-camera.service >/dev/null <<EOF
[Unit]
Description=Project DELTA camera service (Picamera2 + OpenCV)
Wants=delta-server.service
After=delta-server.service

[Service]
User=$APP_USER
ExecStart=$PYTHON3 $CAMERA_SCRIPT --test
Restart=always
RestartSec=5
Environment=DELTA_API_HOST=localhost
Environment=DELTA_API_PORT=8000
Environment=DELTA_CAPTURE_INTERVAL=3.0

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl enable delta-camera.service
else
  echo "==> [6/7] Skipping camera service (camera_reader.py not found)"
fi

# 7) Final reload and enable ----------------------------------------------
echo "==> [7/7] Reloading systemd and enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable delta-server.service delta-kiosk.service

cat <<EOF

===============================================================
 Autostart installed!

   delta-server.service -> API on http://localhost:8000
   delta-kiosk.service  -> Chromium fullscreen kiosk
   delta-camera.service -> Picamera2 + OpenCV (test mode)
   touch calibration    -> portrait mode via udev + hwdb
   lightdm setup        -> udev trigger before session start

 Finish with:   sudo reboot
 Remove later:  sudo systemctl disable --now delta-kiosk delta-server delta-camera
===============================================================
EOF
