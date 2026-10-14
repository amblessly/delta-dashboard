"""lactate.py — Lactate percentage from colorimetric strip analysis.

Uses ONLY the Lactate calibration dataset to convert measured color
into a Lactate percentage. Completely independent of Sodium.

CRITICAL:
- The 50% baseline is BLUE.
- Increasing percentage progresses toward YELLOW/PALE.
- Percentages come ONLY from physical calibration data.
- BCG color names are descriptive — they never drive the %.
"""
from .bcg_classifier import classify_bcg_from_calibration
from .confidence import calculate_confidence


def measure_lactate(color_result, detection_result, calibration_dataset):
    """Calculate Lactate percentage from strip color measurement.

    Args:
        color_result: dict from color_analysis.analyze_multi_frame
        detection_result: dict from strip_detector.detect
        calibration_dataset: CalibrationDataset for Lactate.

    Returns:
        dict with percentage, rgb, hsv, color_state, confidence, etc.
    """
    if color_result is None:
        return _no_measurement("No color data available")

    rgb = color_result["rgb"]
    hsv = color_result["hsv"]

    # Validate calibration before producing any result
    valid, msg = calibration_dataset._check_valid_for_measurement()
    if not valid:
        return {
            "percentage": None,
            "rgb": rgb,
            "hsv": hsv,
            "color_state": "UNKNOWN",
            "color_state_index": -1,
            "confidence": {
                "score": 0,
                "level": "VERY_LOW",
                "factors": {},
                "message": f"CALIBRATION ERROR — {msg}",
            },
            "raw_distance": float("inf"),
            "calibration_conf_factor": 0,
            "outside_range": False,
        }

    # Check if color is outside calibration range
    outside_range = calibration_dataset.is_outside_range(rgb, hsv)

    # BCG color state — descriptive only, never drives percentage
    bcg = classify_bcg_from_calibration(rgb, hsv, calibration_dataset)

    # Interpolate percentage from calibration trajectory
    percentage, conf_factor = calibration_dataset.interpolate(rgb, hsv)

    # Confidence scoring
    confidence = calculate_confidence(color_result, detection_result, calibration_dataset)

    # Override confidence if outside range
    if outside_range:
        confidence["score"] = min(confidence["score"], 25)
        confidence["level"] = "LOW"
        confidence["message"] = "OUTSIDE CALIBRATION RANGE — low confidence"

    if bcg["state"] == "UNKNOWN":
        confidence["score"] *= 0.5
        confidence["message"] = "Cannot classify BCG state — verify calibration"

    return {
        "percentage": round(percentage, 1) if percentage is not None else None,
        "rgb": rgb,
        "hsv": hsv,
        "color_state": bcg["state"],
        "color_state_index": bcg.get("continuous_index", -1),
        "confidence": confidence,
        "raw_distance": bcg["distance"],
        "calibration_conf_factor": conf_factor,
        "outside_range": outside_range,
    }


def measure_lactate_from_roi(frame, roi, mask, detection_result,
                              calibration_dataset):
    """Convenience: measure Lactate directly from frame + ROI."""
    from .color_analysis import extract_roi_color
    color = extract_roi_color(frame, roi, mask)
    return measure_lactate(color, detection_result, calibration_dataset)


def _no_measurement(reason):
    return {
        "percentage": None,
        "rgb": None,
        "hsv": None,
        "color_state": "UNKNOWN",
        "color_state_index": -1,
        "confidence": {
            "score": 0,
            "level": "VERY_LOW",
            "factors": {},
            "message": reason,
        },
        "raw_distance": float("inf"),
        "calibration_conf_factor": 0,
        "outside_range": False,
    }
