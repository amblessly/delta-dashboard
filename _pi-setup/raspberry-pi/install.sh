#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Project DELTA dashboard - Raspberry Pi / Linux installer (step 1 of 2)
# Installs system packages, Node.js, app dependencies, and the database
# schema. Run this AFTER filling in server/.env (see README).
#
# Usage:  bash raspberry-pi/install.sh
# ---------------------------------------------------------------------
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"

echo "==> DELTA dashboard install"
echo "    repo:   $REPO_DIR"

# 1) System packages ---------------------------------------------------
echo "==> [1/4] Installing system packages..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y git curl ca-certificates chromium-browser
else
  echo "    (non-apt system: install chromium + git manually)"
fi

# 2) Node.js >= 18 ------------------------------------------------------
echo "==> [2/4] Checking Node.js..."
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -ge 18 ]; then NEED_NODE=0; echo "    Node $(node -v) OK"; fi
fi
if [ "$NEED_NODE" = "1" ]; then
  echo "    Installing Node.js 20.x (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y nodejs
  else
    echo "ERROR: install Node.js 18+ manually: https://nodejs.org" >&2; exit 1;
  fi
fi

# 3) App dependencies ----------------------------------------------------
echo "==> [3/4] Installing npm dependencies..."
cd "$SERVER_DIR"
npm install --no-fund --no-audit

# 4) Environment + database schema ---------------------------------------
echo "==> [4/4] Environment + database"
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "***************************************************************"
  echo "*  CREATED server/.env - EDIT IT NOW:"
  echo "*    nano $SERVER_DIR/.env"
  echo "*  Paste your Neon connection string as DATABASE_URL."
  echo "***************************************************************"
  echo ""
  read -r -p "Press ENTER after editing .env to continue with DB setup (Ctrl+C to stop)..."
fi

if grep -q "USER:PASSWORD@HOST" .env; then
  echo "WARNING: .env still contains template values - skipping DB setup."
  echo "Fill it in, then run again to apply the schema."
else
  npm run setup-db
fi

cat <<EOF

===============================================================
 Install complete!

 Next step - optional autostart on boot (kiosk mode):
     bash raspberry-pi/install-services.sh && sudo reboot

 Manual run instead:
     cd server && npm start      ->  http://localhost:8000
===============================================================
EOF
