#!/usr/bin/env python3
"""MLX90640 thermal camera reader for Project DELTA.

Reads the 32x24 thermal frame from the MLX90640 via I2C,
posts the max skin-region temperature to /api/measurements,
and serves the full thermal frame + stress estimate as JSON
on port 8001 for the frontend heatmap visualization.

Stress estimation is heuristic only.  MLX90640 measures infrared
surface (skin) temperature, NOT core body temperature.  Results are
labeled "Estimated stress indicator" — not a medical diagnosis.

Wiring (Raspberry Pi GPIO header):
  Pin 1  = 3.3V  -> MLX90640 VIN
  Pin 3  = GPIO 2 (SDA1) -> MLX90640 SDA
  Pin 5  = GPIO 3 (SCL1) -> MLX90640 SCL
  Pin 6  = GND   -> MLX90640 GND
"""
import json
import time
import math
import socket
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import URLError

import board
import busio
import adafruit_mlx90640

# Import stress estimator for temperature-based stress contribution
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stress_estimator

# ── Config ─────────────────────────────────────────────────────
API_BASE     = "http://localhost:8000"
POST_EVERY   = 3.0        # seconds between API POSTs
FRAME_hz    = 4          # MLX90640 refresh rate
MIN_TEMP     = 15.0       # absolute floor for valid readings
MAX_TEMP     = 55.0       # absolute ceiling for valid readings
SKIN_MIN     = 30.0       # minimum plausible skin temperature
SKIN_MAX     = 42.0       # maximum plausible skin temperature
HEAT_SOURCE_THRESHOLD = 37.0  # if min in skin zone > this, likely Pi board heat
THERMAL_PORT = 8001       # local HTTP for frontend heatmap
STUDENT_POLL = 5.0        # seconds between student list polls

# ── State ──────────────────────────────────────────────────────
latest_frame = [0.0] * 768   # 32 x 24
latest_meta  = {}
frame_lock   = threading.Lock()
active_student = None

# ── MLX90640 init ──────────────────────────────────────────────
def init_mlx():
    i2c = busio.I2C(board.SCL, board.SDA, frequency=800000)
    mlx = adafruit_mlx90640.MLX90640(i2c)
    mlx.refresh_rate = adafruit_mlx90640.RefreshRate.REFRESH_4_HZ
    print(f"[thermal] MLX90640 initialized, {FRAME_hz}Hz")
    return mlx

# ── Helpers ────────────────────────────────────────────────────
def safe_post(url, payload, timeout=5):
    try:
        req = Request(url, data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        with urlopen(req, timeout=timeout) as resp:
            return resp.status
    except (URLError, OSError) as e:
        print(f"[thermal] POST {url} failed: {e}")
        return 0

def get_active_student():
    try:
        with urlopen(f"{API_BASE}/api/students", timeout=5) as resp:
            students = json.loads(resp.read())
        return students[0] if students else None
    except Exception:
        return None

def frame_to_grid(frame):
    """Convert flat 768-list to 24-row x 32-col grid."""
    return [frame[r*32:(r+1)*32] for r in range(24)]

# ── Reader loop ────────────────────────────────────────────────
def reader_loop():
    global active_student
    mlx = init_mlx()
    last_post = 0
    last_student_poll = 0
    frame_buf = [0.0] * 768

    # Poll for active student immediately at startup
    active_student = get_active_student()
    last_student_poll = time.time()
    if active_student:
        print(f"[thermal] Active student: {active_student.get('name')} (ID {active_student.get('studentCode')})")
    else:
        print("[thermal] No active student found at startup")

    while True:
        try:
            mlx.getFrame(frame_buf)
        except Exception as e:
            print(f"[thermal] frame read error: {e}")
            time.sleep(1)
            continue

        now = time.time()
        temps = list(frame_buf)

        with frame_lock:
            latest_frame[:] = temps

            # Skin detection zone: center-left area, avoiding right edge (Pi CPU heat zone)
            # MLX90640 is 32x24. Right columns 28-31 pick up Pi board heat.
            center_temps = []
            for row in range(4, 20):     # rows 4-19 (wide vertical center)
                for col in range(2, 26):  # cols 2-25 (avoid right 6 cols = Pi board)
                    t = temps[row * 32 + col]
                    if SKIN_MIN <= t <= SKIN_MAX:
                        center_temps.append(t)

            # Detect if sensor is reading Pi board heat: all readings above threshold
            all_center = []
            for row in range(4, 20):
                for col in range(2, 26):
                    all_center.append(temps[row * 32 + col])

            heat_source = False
            if all_center and min(all_center) > HEAT_SOURCE_THRESHOLD:
                heat_source = True

            max_temp = max(center_temps) if center_temps else None
            avg_temp = sum(center_temps) / len(center_temps) if center_temps else None
            min_temp = min(temps) if temps else None
            max_all  = max(temps) if temps else None

            latest_meta.update({
                "timestamp": now,
                "max_skin": round(max_temp, 1) if max_temp else None,
                "avg_skin": round(avg_temp, 1) if avg_temp else None,
                "min_frame": round(min_temp, 1) if min_temp else None,
                "max_frame": round(max_all, 1) if max_all else None,
                "heatSource": heat_source,
            })

        # Post temperature to API every POST_EVERY seconds
        if max_temp and SKIN_MIN <= max_temp <= SKIN_MAX and (now - last_post) >= POST_EVERY:
            last_post = now

            # Poll for active student if needed
            if (now - last_student_poll) >= STUDENT_POLL:
                active_student = get_active_student()
                last_student_poll = now

            if active_student:
                safe_post(f"{API_BASE}/api/measurements", {
                    "studentCode": active_student.get("studentCode"),
                    "source": "mlx90640_thermal",
                    "metrics": {"temperature": round(max_temp, 1)},
                })
                print(f"[thermal] Posted {round(max_temp, 1)}C for student {active_student.get('studentCode')}")

        time.sleep(1.0 / FRAME_hz)

# ── HTTP server for frontend heatmap ───────────────────────────
class ThermalHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/thermal":
            with frame_lock:
                data = {
                    "grid": frame_to_grid(list(latest_frame)),
                    "meta": dict(latest_meta),
                }
                # Include stress estimate for the active student
                if active_student and latest_meta.get("max_skin"):
                    sc = active_student.get("studentCode")
                    if sc is not None:
                        stress_data = stress_estimator.calculate_temperature_contribution(
                            sc, latest_meta["max_skin"], latest_meta.get("timestamp")
                        )
                        stress_data["confidence"] = stress_estimator.calculate_confidence(sc)
                        data["stress"] = stress_data
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress request logging

def http_server():
    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True
        allow_reuse_port = True
    server = ReusableHTTPServer(("0.0.0.0", THERMAL_PORT), ThermalHandler)
    print(f"[thermal] HTTP server on http://localhost:{THERMAL_PORT}/thermal")
    server.serve_forever()

# ── Main ───────────────────────────────────────────────────────
if __name__ == "__main__":
    print("[thermal] Starting MLX90640 thermal reader...")
    t_http = threading.Thread(target=http_server, daemon=True)
    t_http.start()
    reader_loop()
