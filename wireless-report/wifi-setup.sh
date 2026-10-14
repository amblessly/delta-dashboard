#!/bin/sh
# DELTA wireless-report: connect the Pi to a WiFi network (run ON the Pi).
#
#   1) cp wifi.env.example wifi.env
#   2) edit wifi.env  ->  SSID=YourNetwork   WIFI_PASS=YourPassword
#   3) bash wifi-setup.sh
#
# Works with NetworkManager (nmcli) or falls back to wpa_supplicant.
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
if [ ! -f "$DIR/wifi.env" ]; then
  echo "Missing wifi.env. Copy wifi.env.example to wifi.env and fill in SSID + WIFI_PASS."
  exit 1
fi
. "$DIR/wifi.env"

[ -n "${SSID:-}" ] || { echo "SSID is empty in wifi.env"; exit 1; }

echo "Connecting wlan0 to SSID '$SSID' ..."

if command -v nmcli >/dev/null 2>&1; then
  if [ -n "${WIFI_PASS:-}" ]; then
    nmcli device wifi connect "$SSID" password "$WIFI_PASS"
  else
    nmcli device wifi connect "$SSID"
  fi
else
  WPA="/etc/wpa_supplicant/wpa_supplicant.conf"
  sudo cp "$WPA" "$WPA.backup.$(date +%s)"
  sudo bash -c "cat >> $WPA <<'EOF2'

network={
    ssid=\"$SSID\"
    psk=\"$WIFI_PASS\"
    key_mgmt=WPA-PSK
}
EOF2"
  sudo wpa_cli -i wlan0 reconfigure 2>/dev/null || sudo systemctl restart wpa_supplicant
fi

sleep 8

echo "---"
IPS=$(hostname -I 2>/dev/null)
echo "wlan0 IP(s): $IPS"
for ip in $IPS; do
  case "$ip" in
    192.168.*|10.*|172.*) echo "Report page:  http://$ip:8081" ;;
  esac
done