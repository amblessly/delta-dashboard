"""session.py — Colorimetric test session management.

Manages the full pipeline: strip detection, color measurement,
Sodium/Lactate calculation, combined status, and result storage.

Pipeline:
1. Camera warmup (handled by camera module)
2. Multi-frame capture (configurable count)
3. Strip detection + ROI quality
4. Multi-frame color analysis (RGB + HSV + Lab)
5. Baseline comparison + drift check
6. Calibration interpolation
7. Confidence scoring (9+ factors)
8. Combined status
9. Full data logging
"""
import json
import time
import uuid
from pathlib import Path


_DEFAULT_DATA_DIR = Path(__file__).parent / "data"
_DEFAULT_RESULTS_FILE = _DEFAULT_DATA_DIR / "results.json"


class ColorimetricSession:
    """A single colorimetric test session.

    Orchestrates the full pipeline from camera capture to result.
    """

    def __init__(self, camera, calibration_manager):
        self.camera = camera
        self.calibration = calibration_manager
        self.session_id = str(uuid.uuid4())[:12]
        self.start_time = time.time()
        self._result = None

    def run_test(self, analyzer=None, detector=None):
        """Execute a complete colorimetric test.

        Returns dict with full test results including quality metrics.
        """
        from . import strip_detector as _sd
        from . import color_analysis as _ca
        from . import sodium as _na
        from . import lactate as _la

        if detector is None:
            detector = _sd.StripDetector()

        result = {
            "session_id": self.session_id,
            "timestamp": time.time(),
            "duration_ms": 0,
            "strip_detected": False,
            "frame_count": 0,
            "sodium": None,
            "lactate": None,
            "combined": None,
            "combined_status": None,
            "quality": {},
        }

        t0 = time.time()

        # Step 1: Capture multiple frames (default 20 from camera config)
        frames = self.camera.capture_frames()
        result["frame_count"] = len(frames)
        if not frames:
            result["error"] = "No frames captured"
            result["duration_ms"] = round((time.time() - t0) * 1000)
            self._result = result
            return result

        # Step 2: Detect strip in first frame
        detection = detector.detect_dual_zones(frames[0])
        result["strip_detected"] = detection["detected"]
        result["detection_confidence"] = detection["confidence"]
        result["roi_quality"] = detection.get("roi_quality", {})
        result["position_check"] = detection.get("position_check", {})

        if not detection["detected"]:
            result["error"] = "Strip not detected"
            result["duration_ms"] = round((time.time() - t0) * 1000)
            self._result = result
            return result

        # Position check
        pos = detection.get("position_check", {})
        if isinstance(pos, dict) and not pos.get("valid", True):
            result["error"] = pos.get("message", "STRIP POSITION INVALID")
            result["duration_ms"] = round((time.time() - t0) * 1000)
            self._result = result
            return result

        # ROI quality check
        roi_q = detection.get("roi_quality", {})
        if isinstance(roi_q, dict) and roi_q.get("score", 0) < 0.2:
            result["error"] = "LOW ROI QUALITY — REPOSITION STRIP"
            result["duration_ms"] = round((time.time() - t0) * 1000)
            self._result = result
            return result

        # Step 3: Analyze color from multiple frames
        sodium_roi = detection.get("sodium_roi")
        lactate_roi = detection.get("lactate_roi")
        reaction_roi = detection.get("reaction_roi")
        mask = detection.get("reaction_mask")

        # Sodium measurement (independent ROI)
        if sodium_roi:
            sodium_color = _ca.analyze_multi_frame(frames, sodium_roi, mask)
        elif reaction_roi:
            sodium_color = _ca.analyze_multi_frame(frames, reaction_roi, mask)
        else:
            sodium_color = None

        # Lactate measurement (independent ROI)
        if lactate_roi:
            lactate_color = _ca.analyze_multi_frame(frames, lactate_roi, mask)
        elif reaction_roi:
            lactate_color = _ca.analyze_multi_frame(frames, reaction_roi, mask)
        else:
            lactate_color = None

        # Step 4: Calculate Sodium %
        sodium_ds = self.calibration.get_dataset("sodium")
        result["sodium"] = _na.measure_sodium(
            sodium_color, detection, sodium_ds)

        # Step 5: Calculate Lactate %
        lactate_ds = self.calibration.get_dataset("lactate")
        result["lactate"] = _la.measure_lactate(
            lactate_color, detection, lactate_ds)

        # Step 6: Combined Status
        s_pct = result["sodium"]["percentage"]
        l_pct = result["lactate"]["percentage"]
        if s_pct is not None and l_pct is not None:
            combined = (s_pct * 0.50) + (l_pct * 0.50)
            result["combined"] = round(combined, 1)
        elif s_pct is not None:
            result["combined"] = round(s_pct * 0.50, 1)
        elif l_pct is not None:
            result["combined"] = round(l_pct * 0.50, 1)

        if result["combined"] is not None:
            c = result["combined"]
            if c < 25:
                result["combined_status"] = "LOW"
            elif c < 50:
                result["combined_status"] = "MODERATE"
            elif c < 75:
                result["combined_status"] = "ELEVATED"
            else:
                result["combined_status"] = "HIGH"
        else:
            result["combined_status"] = "UNAVAILABLE"

        # Quality summary
        result["quality"] = {
            "frame_count": len(frames),
            "frames_used": (sodium_color or {}).get("frame_count", 0),
            "frames_rejected": (sodium_color or {}).get("frames_rejected", 0),
            "roi_score": roi_q.get("score") if isinstance(roi_q, dict) else None,
            "glare_fraction": (sodium_color or {}).get("glare_fraction"),
            "lighting_score": (sodium_color or {}).get("lighting_score"),
            "consistency": (sodium_color or {}).get("consistency"),
            "calibration_version": self.calibration.version,
        }

        # Raw color data for logging
        if sodium_color:
            result["sodium_raw"] = {
                "rgb": sodium_color.get("rgb"),
                "hsv": sodium_color.get("hsv"),
                "lab": sodium_color.get("lab"),
                "rgb_median": sodium_color.get("rgb_median"),
            }
        if lactate_color:
            result["lactate_raw"] = {
                "rgb": lactate_color.get("rgb"),
                "hsv": lactate_color.get("hsv"),
                "lab": lactate_color.get("lab"),
                "rgb_median": lactate_color.get("rgb_median"),
            }

        result["duration_ms"] = round((time.time() - t0) * 1000)
        self._result = result
        return result

    @property
    def result(self):
        return self._result


def save_result(result, filepath=None):
    """Append a test result to the results file."""
    path = Path(filepath) if filepath else _DEFAULT_RESULTS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)

    results = []
    if path.exists():
        try:
            with open(path, "r") as f:
                results = json.load(f)
        except (json.JSONDecodeError, OSError):
            results = []

    flat = _flatten_result(result)
    results.append(flat)

    with open(path, "w") as f:
        json.dump(results, f, indent=2)

    return flat


def load_results(filepath=None):
    """Load all stored results."""
    path = Path(filepath) if filepath else _DEFAULT_RESULTS_FILE
    if not path.exists():
        return []
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _flatten_result(result):
    """Flatten nested result dict for storage."""
    flat = {
        "session_id": result.get("session_id"),
        "timestamp": result.get("timestamp"),
        "duration_ms": result.get("duration_ms"),
        "strip_detected": result.get("strip_detected"),
        "frame_count": result.get("frame_count"),
        "combined": result.get("combined"),
        "combined_status": result.get("combined_status"),
        "calibration_version": result.get("quality", {}).get("calibration_version", 1),
        "roi_score": result.get("roi_quality", {}).get("score") if isinstance(result.get("roi_quality"), dict) else None,
        "position_valid": result.get("position_check", {}).get("valid") if isinstance(result.get("position_check"), dict) else None,
    }

    s = result.get("sodium") or {}
    flat["sodium_percentage"] = s.get("percentage")
    flat["sodium_rgb"] = s.get("rgb")
    flat["sodium_hsv"] = s.get("hsv")
    flat["sodium_lab"] = (result.get("sodium_raw") or {}).get("lab")
    flat["sodium_color_state"] = s.get("color_state")
    flat["sodium_confidence"] = (s.get("confidence") or {}).get("score")
    flat["sodium_baseline"] = (s.get("confidence") or {}).get("factors", {}).get("baseline_stability")

    l = result.get("lactate") or {}
    flat["lactate_percentage"] = l.get("percentage")
    flat["lactate_rgb"] = l.get("rgb")
    flat["lactate_hsv"] = l.get("hsv")
    flat["lactate_lab"] = (result.get("lactate_raw") or {}).get("lab")
    flat["lactate_color_state"] = l.get("color_state")
    flat["lactate_confidence"] = (l.get("confidence") or {}).get("score")
    flat["lactate_baseline"] = (l.get("confidence") or {}).get("factors", {}).get("baseline_stability")

    q = result.get("quality") or {}
    flat["glare_fraction"] = q.get("glare_fraction")
    flat["lighting_score"] = q.get("lighting_score")
    flat["consistency"] = q.get("consistency")

    return flat
