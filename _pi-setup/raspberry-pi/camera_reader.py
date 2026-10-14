#!/usr/bin/env python3
"""Project DELTA - Raspberry Pi Camera Service
Picamera2 -> OpenCV -> Electrolyte analysis -> POST /api/measurements

Separate from MLX90640 thermal camera.
Primary visual camera via CSI connector.

Usage:
  python3 camera_reader.py              # Normal mode
  python3 camera_reader.py --test       # Simulation mode (no camera needed)
  python3 camera_reader.py --student 101  # Target specific student
"""

import argparse
import json
import logging
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from http.client import HTTPConnection
from urllib.error import URLError

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("delta-camera")

API_HOST = os.environ.get("DELTA_API_HOST", "localhost")
API_PORT = int(os.environ.get("DELTA_API_PORT", "8000"))
CAPTURE_INTERVAL = float(os.environ.get("DELTA_CAPTURE_INTERVAL", "3.0"))
API_BASE = f"http://{API_HOST}:{API_PORT}"

# Electrolyte colorimetric calibration (HSV ranges)
# These are placeholder ranges - must be calibrated with actual test strips
CALIBRATION = {
    "strip_roi": {"x_pct": 0.2, "y_pct": 0.3, "w_pct": 0.6, "h_pct": 0.4},
    "sodium_ranges": [
        {"label": "low", "h_range": (0, 30), "s_range": (50, 150), "v_range": (100, 255), "na_value": 130},
        {"label": "normal", "h_range": (30, 80), "s_range": (80, 200), "v_range": (100, 255), "na_value": 140},
        {"label": "high", "h_range": (80, 140), "s_range": (50, 180), "v_range": (100, 255), "na_value": 155},
    ],
    "confidence_base": 0.6,
    "calibrated": False,
}


def check_camera():
    """Detect Raspberry Pi CSI camera via Picamera2."""
    try:
        from picamera2 import Picamera2
        cameras = Picamera2.global_camera_info()
        if not cameras:
            log.error("[CAMERA ERROR] Raspberry Pi camera not detected")
            return False
        log.info(f"[CAMERA] Raspberry Pi CSI camera detected: {cameras}")
        return True
    except ImportError:
        log.error("[CAMERA ERROR] Picamera2 not installed. Install with: sudo apt install python3-picamera2")
        return False
    except Exception as e:
        log.error(f"[CAMERA ERROR] Camera detection failed: {e}")
        return False


def init_camera():
    """Initialize Picamera2 for RGB frame capture."""
    try:
        from picamera2 import Picamera2
        import numpy as np

        picam2 = Picamera2()
        config = picam2.create_still_configuration(
            main={"size": (1920, 1080), "format": "RGB888"},
            buffer_count=2,
        )
        picam2.configure(config)
        picam2.start()
        time.sleep(2)  # Let sensor warm up
        log.info("[CAMERA] Picamera2 initialized (1920x1080 RGB)")
        return picam2
    except Exception as e:
        log.error(f"[CAMERA ERROR] Init failed: {e}")
        return None


def capture_frame(picam2):
    """Capture a single RGB frame from Picamera2."""
    try:
        import numpy as np
        frame = picam2.capture_array()
        if frame is None:
            log.warning("[CAMERA] Empty frame captured")
            return None
        log.info(f"[CAMERA] Frame captured: {frame.shape[1]}x{frame.shape[0]} ({frame.dtype})")
        return frame
    except Exception as e:
        log.error(f"[CAMERA ERROR] Capture failed: {e}")
        return None


def process_electrolyte(frame):
    """Process frame for electrolyte strip analysis using OpenCV.

    Returns dict with sodium, electrolyte_score, confidence, or None values.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        log.error("[CAMERA ERROR] OpenCV not installed")
        return {"sodium": None, "electrolyte_score": None, "electrolyte_confidence": 0.0}

    h, w = frame.shape[:2]
    roi_cfg = CALIBRATION["strip_roi"]
    x1 = int(w * roi_cfg["x_pct"])
    y1 = int(h * roi_cfg["y_pct"])
    x2 = int(w * (roi_cfg["x_pct"] + roi_cfg["w_pct"]))
    y2 = int(h * (roi_cfg["y_pct"] + roi_cfg["h_pct"]))
    roi = frame[y1:y2, x1:x2]

    if roi.size == 0:
        log.warning("[CAMERA] Empty ROI")
        return {"sodium": None, "electrolyte_score": None, "electrolyte_confidence": 0.0}

    # Color normalization
    roi_float = roi.astype(np.float32) / 255.0
    meanBrightness = np.mean(roi_float)
    if meanBrightness > 0.01:
        roi_normalized = np.clip(roi_float / meanBrightness * 0.5, 0, 1)
    else:
        roi_normalized = roi_float
    roi_uint8 = (roi_normalized * 255).astype(np.uint8)

    # Convert to HSV for colorimetric analysis
    hsv = cv2.cvtColor(roi_uint8, cv2.COLOR_RGB2HSV)

    # Analyze dominant color region
    best_match = None
    best_area = 0

    for sr in CALIBRATION["sodium_ranges"]:
        mask = cv2.inRange(
            hsv,
            np.array([sr["h_range"][0], sr["s_range"][0], sr["v_range"][0]]),
            np.array([sr["h_range"][1], sr["s_range"][1], sr["v_range"][1]]),
        )
        area = cv2.countNonZero(mask)
        if area > best_area:
            best_area = area
            best_match = sr

    total_pixels = roi.shape[0] * roi.shape[1]
    match_ratio = best_area / total_pixels if total_pixels > 0 else 0

    if best_match is None or match_ratio < 0.05:
        # No clear color match - calibration may be needed
        log.info("[CAMERA] No electrolyte strip detected in ROI")
        return {
            "sodium": None,
            "electrolyte_score": None,
            "electrolyte_confidence": 0.0,
            "status": "Calibration Required",
        }

    # Calculate electrolyte score from color analysis
    sodium = best_match["na_value"]
    # Map sodium to electrolyte score (ideal ~140 mEq/L)
    electrolyte_score = max(0, min(100, 100 - abs(sodium - 140) * 3))
    confidence = min(CALIBRATION["confidence_base"] + match_ratio * 0.3, 1.0)

    # Lactate estimation from secondary color features (placeholder)
    # Real implementation needs specific calibration data
    lactate = None

    result = {
        "sodium": round(sodium, 1),
        "electrolyte_score": round(electrolyte_score, 1),
        "electrolyte_confidence": round(confidence, 2),
        "lactate": lactate,
        "strip_detected": True,
        "match_ratio": round(match_ratio, 3),
        "status": "ok" if CALIBRATION["calibrated"] else "Calibration Required",
    }

    log.info(
        f"[CAMERA] Electrolyte analysis: Na={sodium} mEq/L, "
        f"score={electrolyte_score:.1f}%, confidence={confidence:.2f}, "
        f"match={match_ratio:.3f}"
    )
    return result


def get_first_student():
    """Get the first enrolled student code from the API."""
    try:
        conn = HTTPConnection(API_HOST, API_PORT, timeout=5)
        conn.request("GET", "/api/students")
        resp = conn.getresponse()
        if resp.status == 200:
            students = json.loads(resp.read().decode())
            if isinstance(students, list) and len(students) > 0:
                code = students[0].get("studentCode")
                conn.close()
                return code
        conn.close()
    except Exception as e:
        log.warning(f"[CAMERA] Could not fetch students: {e}")
    return None


def post_measurement(student_code, electrolyte_data, source="raspberry_pi_camera"):
    """POST measurement to the DELTA API."""
    measurement_id = f"cam-{uuid.uuid4().hex[:12]}"

    payload = {
        "studentCode": student_code,
        "source": source,
        "measurementId": measurement_id,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "metrics": {},
    }

    if electrolyte_data.get("electrolyte_score") is not None:
        payload["metrics"]["electrolytes"] = electrolyte_data["electrolyte_score"]
    if electrolyte_data.get("sodium") is not None:
        payload["metrics"]["sodium"] = electrolyte_data["sodium"]
    if electrolyte_data.get("lactate") is not None:
        payload["metrics"]["lactate"] = electrolyte_data["lactate"]

    if electrolyte_data.get("electrolyte_confidence") is not None:
        payload["electrolyteConfidence"] = electrolyte_data["electrolyte_confidence"]

    if not payload["metrics"]:
        log.warning("[CAMERA] No valid metrics to post")
        return False

    try:
        body = json.dumps(payload)
        conn = HTTPConnection(API_HOST, API_PORT, timeout=10)
        conn.request("POST", "/api/measurements", body, {"Content-Type": "application/json"})
        resp = conn.getresponse()
        data = resp.read().decode()
        conn.close()

        if resp.status in (200, 201):
            log.info(f"[CAMERA] Measurement posted (id={measurement_id})")
            return True
        else:
            log.warning(f"[CAMERA] API returned {resp.status}: {data}")
            return False
    except Exception as e:
        log.error(f"[CAMERA] POST failed: {e}")
        return False


def simulate_measurement():
    """Generate simulated electrolyte data for test mode."""
    import random
    sodium = round(random.uniform(130, 150), 1)
    score = round(max(0, min(100, 100 - abs(sodium - 140) * 3)), 1)
    return {
        "sodium": sodium,
        "electrolyte_score": score,
        "electrolyte_confidence": round(random.uniform(0.5, 0.9), 2),
        "lactate": round(random.uniform(1.0, 3.5), 2),
        "strip_detected": True,
        "match_ratio": round(random.uniform(0.3, 0.8), 3),
        "status": "simulated",
    }


def run_camera_loop(picam2, student_code, test_mode=False):
    """Main capture-process-post loop."""
    log.info(f"[CAMERA] Starting loop (student={student_code}, interval={CAPTURE_INTERVAL}s, test={test_mode})")
    consecutive_errors = 0

    while True:
        try:
            if test_mode:
                data = simulate_measurement()
            else:
                frame = capture_frame(picam2)
                if frame is None:
                    consecutive_errors += 1
                    if consecutive_errors > 10:
                        log.error("[CAMERA] Too many consecutive errors, pausing 30s")
                        time.sleep(30)
                        consecutive_errors = 0
                    time.sleep(1)
                    continue
                consecutive_errors = 0
                data = process_electrolyte(frame)

            post_measurement(student_code, data)

        except KeyboardInterrupt:
            log.info("[CAMERA] Stopped by user")
            break
        except Exception as e:
            log.error(f"[CAMERA ERROR] {e}")

        time.sleep(CAPTURE_INTERVAL)


def main():
    parser = argparse.ArgumentParser(description="Project DELTA Camera Service")
    parser.add_argument("--test", action="store_true", help="Simulation mode (no camera)")
    parser.add_argument("--student", type=int, default=None, help="Student code (default: auto-detect)")
    parser.add_argument("--interval", type=float, default=3.0, help="Capture interval in seconds")
    args = parser.parse_args()

    global CAPTURE_INTERVAL
    CAPTURE_INTERVAL = args.interval

    log.info("[CAMERA] Project DELTA Camera Service starting")
    log.info(f"[CAMERA] API endpoint: {API_BASE}")

    # Get student code
    student_code = args.student
    if student_code is None:
        student_code = get_first_student()
        if student_code is None:
            log.error("[CAMERA ERROR] No students enrolled. Enroll a student first.")
            sys.exit(1)
    log.info(f"[CAMERA] Target student: {student_code}")

    if args.test:
        log.info("[CAMERA] Running in TEST/SIMULATION mode")
        run_camera_loop(None, student_code, test_mode=True)
        return

    # Normal mode - check and init camera
    if not check_camera():
        log.error("[CAMERA ERROR] Camera not available. Use --test for simulation mode.")
        sys.exit(1)

    picam2 = init_camera()
    if picam2 is None:
        log.error("[CAMERA ERROR] Failed to initialize camera")
        sys.exit(1)

    log.info("[CAMERA] OpenCV processing active")
    try:
        run_camera_loop(picam2, student_code, test_mode=False)
    finally:
        try:
            picam2.stop()
            log.info("[CAMERA] Camera released")
        except Exception:
            pass


if __name__ == "__main__":
    main()
