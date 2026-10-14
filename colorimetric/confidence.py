"""confidence.py — Comprehensive confidence scoring for colorimetric measurements.

Incorporates 9+ factors:
1. Color distance to nearest calibration point
2. Pixel coverage
3. Frame consistency
4. Detection quality / ROI quality
5. Calibration coverage (density of calibration points)
6. Color uniformity
7. Calibration direction validity
8. Glare fraction
9. Lighting consistency
10. Strip positioning
11. Baseline drift / environment match
12. Calibration validation performance (MAE)
"""
import math


def calculate_confidence(color_result, detection_result, calibration_dataset,
                         baseline=None):
    """Calculate composite confidence score for a measurement.

    Args:
        color_result: dict from color_analysis.analyze_multi_frame
        detection_result: dict from strip_detector.detect
        calibration_dataset: CalibrationDataset for the analyte.
        baseline: Optional Baseline for drift check.

    Returns:
        dict with score, level, factors, message.
    """
    factors = {}

    # Factor 1: Color distance to nearest calibration point (0-100)
    if color_result and calibration_dataset and not calibration_dataset.is_empty():
        _, _, dist = calibration_dataset.find_closest(
            color_result["rgb"], color_result["hsv"])
        color_match = max(0, 100 - dist * 2)
        factors["color_match"] = min(100, color_match)
    else:
        factors["color_match"] = 0

    # Factor 2: Valid pixel coverage (0-100)
    if color_result:
        coverage = color_result.get("coverage", 0)
        factors["pixel_coverage"] = min(100, coverage * 125)
    else:
        factors["pixel_coverage"] = 0

    # Factor 3: Frame consistency (0-100)
    if color_result:
        consistency = color_result.get("consistency", 0)
        factors["frame_consistency"] = min(100, consistency * 100)
    else:
        factors["frame_consistency"] = 0

    # Factor 4: ROI quality (0-100)
    if detection_result:
        roi_q = detection_result.get("roi_quality", {})
        roi_score = roi_q.get("score", 0) if isinstance(roi_q, dict) else 0
        factors["roi_quality"] = min(100, roi_score * 100)
    else:
        factors["roi_quality"] = 0

    # Factor 5: Calibration coverage (0-100)
    if calibration_dataset and len(calibration_dataset.points) >= 2:
        rng = calibration_dataset.coverage_range()
        if rng:
            span = rng[1] - rng[0]
            n_points = len(calibration_dataset.points)
            # More points + wider span = better coverage
            density_score = min(100, span * 1.5 + n_points * 5)
            factors["calibration_coverage"] = min(100, density_score)
        else:
            factors["calibration_coverage"] = 0
    elif calibration_dataset and len(calibration_dataset.points) == 1:
        factors["calibration_coverage"] = 20
    else:
        factors["calibration_coverage"] = 0

    # Factor 6: Color uniformity (low std = uniform = better)
    if color_result:
        rgb_std = color_result.get("rgb_std", [50, 50, 50])
        avg_std = sum(rgb_std) / len(rgb_std) if rgb_std else 50
        factors["color_uniformity"] = max(0, min(100, 100 - avg_std))
    else:
        factors["color_uniformity"] = 0

    # Factor 7: Calibration direction validity
    if calibration_dataset and len(calibration_dataset.points) >= 2:
        direction = calibration_dataset.validate_direction()
        factors["calibration_direction"] = 100 if direction["valid"] else 0
    else:
        factors["calibration_direction"] = 0

    # Factor 8: Glare fraction (lower = better)
    if color_result:
        glare_frac = color_result.get("glare_fraction", 0)
        factors["glare_fraction"] = max(0, min(100, (1.0 - glare_frac * 10) * 100))
    else:
        factors["glare_fraction"] = 0

    # Factor 9: Lighting consistency (0-100)
    if color_result:
        lighting = color_result.get("lighting_score", 1.0)
        factors["lighting_consistency"] = min(100, lighting * 100)
    else:
        factors["lighting_consistency"] = 0

    # Factor 10: Strip positioning (0-100)
    if detection_result:
        pos = detection_result.get("position_check", {})
        if isinstance(pos, dict) and pos.get("valid", False):
            # Better score for lower offset
            offset = pos.get("position_offset", 0)
            factors["strip_position"] = max(0, min(100, (1.0 - offset) * 100))
        else:
            factors["strip_position"] = 0
    else:
        factors["strip_position"] = 0

    # Factor 11: Baseline environment match (0-100)
    if baseline and baseline.is_set and color_result:
        drift = baseline.check_drift(color_result["rgb"], color_result["hsv"])
        if not drift.get("drifted", False):
            factors["baseline_stability"] = 100
        else:
            dist = drift.get("distance", 0)
            factors["baseline_stability"] = max(0, min(100, 100 - dist * 2))
    else:
        factors["baseline_stability"] = 50  # neutral if no baseline check

    # Factor 12: Calibration quality (MAE from validation)
    if calibration_dataset:
        val = calibration_dataset.validate_self()
        if isinstance(val, dict) and val.get("mae") is not None:
            mae = val["mae"]
            factors["calibration_quality"] = max(0, min(100, 100 - mae * 2))
        else:
            factors["calibration_quality"] = 30  # unknown quality
    else:
        factors["calibration_quality"] = 0

    # Weighted average
    weights = {
        "color_match": 0.18,
        "pixel_coverage": 0.08,
        "frame_consistency": 0.10,
        "roi_quality": 0.10,
        "calibration_coverage": 0.08,
        "color_uniformity": 0.06,
        "calibration_direction": 0.08,
        "glare_fraction": 0.06,
        "lighting_consistency": 0.06,
        "strip_position": 0.06,
        "baseline_stability": 0.06,
        "calibration_quality": 0.08,
    }

    total = 0
    total_weight = 0
    for key, w in weights.items():
        total += factors.get(key, 0) * w
        total_weight += w

    score = total / total_weight if total_weight > 0 else 0
    score = round(max(0, min(100, score)), 1)

    # Determine level
    if score >= 70:
        level = "HIGH"
        message = "Confident measurement"
    elif score >= 45:
        level = "MEDIUM"
        message = "Moderate confidence — verify with known reference"
    elif score >= 25:
        level = "LOW"
        message = "LOW CONFIDENCE — reinsert strip"
    else:
        level = "VERY_LOW"
        message = "MEASUREMENT INVALID — reinsert strip"

    # Fatal overrides
    if detection_result and not detection_result.get("detected", False):
        score = 0
        level = "VERY_LOW"
        message = "Strip not detected — reinsert strip"

    if calibration_dataset and len(calibration_dataset.points) >= 2:
        direction = calibration_dataset.validate_direction()
        if not direction["valid"]:
            score = 0
            level = "VERY_LOW"
            message = f"CALIBRATION ERROR — {direction['message']}"

    # Glare fatal threshold
    if color_result and color_result.get("glare_fraction", 0) > 0.15:
        score = min(score, 15)
        level = "VERY_LOW"
        message = "GLARE DETECTED — RECAPTURE"

    # Lighting mismatch
    if color_result and color_result.get("lighting_score", 1.0) < 0.3:
        score = min(score, 20)
        level = "LOW"
        message = "LIGHTING MISMATCH — LOW CONFIDENCE"

    return {
        "score": score,
        "level": level,
        "factors": factors,
        "message": message,
    }


def format_confidence(conf_result):
    """Format confidence for display."""
    score = conf_result["score"]
    level = conf_result["level"]
    msg = conf_result["message"]
    return f"{score:.0f}% ({level}) — {msg}"
