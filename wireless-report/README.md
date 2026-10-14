# DELTA Wireless Report

A standalone read-only reporting website that runs on the Raspberry Pi and
lists every detection session sided into **time segments** (e.g. per-minute
averages of electrolytes, hydration, stress, sodium, lactate, temperature).

It reads the **same cloud database** the dashboard writes to, so no data
"transfer" step is needed — as soon as a session is saved, it appears here.
Works over WiFi, no cable to the laptop required.

## Deploy (on the Pi)

    mkdir -p /home/delta/wireless-report/public
    <copy report-server.js, package.json, public/ into that folder>
    cd /home/delta/wireless-report
    npm install --omit=dev
    nohup node report-server.js > report.log 2>&1 &

It finds the database via `DATABASE_URL` from `~/delta-dashboard/server/.env`
(or from a `wireless-report/.env` / environment variable).

Open the page at `http://<pi-ip>:8081` (port 8081, separate from the dashboard's 8000).

## Wireless (untethered) use

    cd /home/delta/wireless-report
    cp wifi.env.example wifi.env
    nano wifi.env          # set SSID and WIFI_PASS
    bash wifi-setup.sh

The script connects `wlan0` to that network (NetworkManager or wpa_supplicant),
then prints the address, e.g. `http://192.168.x.x:8081`. Any phone/laptop on
the same network opens the report there.

## API

    GET /api/health                     -> { ok, db }
    GET /api/students                   -> list of students
    GET /api/sessions                   -> sessions with overall averages
    GET /api/sessions/:id/segments?seg=60 -> per-segment averages (seconds)

## Notes

- Read-only: no endpoint writes to the database.
- Port 8081 was chosen so it never conflicts with the dashboard (8000).
- For auto-start at boot add a systemd user unit (see README at repo root guidance); not enabled by default.