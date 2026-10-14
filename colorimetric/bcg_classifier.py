"""bcg_classifier.py — BCG (Bromocresol Green) color state classifier.

Classifies the measured color of a reaction area into one of six
BCG color states based on calibration data boundaries.

DO NOT hard-code arbitrary RGB thresholds.
Boundaries are derived from calibration points.
"""
import numpy as np


BCG_STATES = [
    "BLUE",
    "BLUE-GREEN",
    "GREEN",
    "YELLOW-GREEN",
    "YELLOW",
    "PALE",
]


def classify_bcg_from_calibration(rgb, hsv, calibration_dataset):
    """Classify BCG color state using calibration data boundaries.

    The classifier finds the nearest calibration point and returns
    its color state, along with a position score (0-5) for interpolation.

    Args:
        rgb: [R, G, B] measured color.
        hsv: [H, S, V] measured color.
        calibration_dataset: CalibrationDataset with reference points.

    Returns:
        dict with:
            state: str (e.g., "BLUE-GREEN")
            state_index: float 0-5 (continuous position for interpolation)
            nearest_point: CalibrationPoint or None
            distance: float (color distance to nearest point)
    """
    if not calibration_dataset or not calibration_dataset.points:
        return {
            "state": "UNKNOWN",
            "state_index": -1,
            "nearest_point": None,
            "distance": float("inf"),
        }

    from .color_analysis import color_distance_combined

    best_idx = 0
    best_dist = float("inf")
    for i, p in enumerate(calibration_dataset.points):
        d = color_distance_combined(rgb, p.rgb, hsv, p.hsv)
        if d < best_dist:
            best_dist = d
            best_idx = i

    nearest = calibration_dataset.points[best_idx]

    # Map color_state string to index
    state_str = nearest.color_state.upper() if nearest.color_state else "UNKNOWN"
    state_index = BCG_STATES.index(state_str) if state_str in BCG_STATES else -1

    # Compute continuous position if we have nearby points
    continuous_index = state_index
    if state_index >= 0 and len(calibration_dataset.points) > 1:
        # Refine index by looking at color progression
        continuous_index = _refine_state_position(rgb, hsv,
                                                   calibration_dataset, best_idx)

    return {
        "state": state_str,
        "state_index": state_index,
        "continuous_index": continuous_index,
        "nearest_point": nearest,
        "distance": best_dist,
    }


def classify_bcg_simple(rgb, hsv):
    """Simple BCG classification using HSV hue ranges.

    This is a fallback when no calibration data is available.
    Provides rough classification only — NOT for measurement.

    DO NOT use this for Sodium/Lactate percentage calculation.
    """
    h, s, v = hsv[:3]

    # BCG in alkaline solution: Blue (high pH) → Yellow (low pH)
    # Hue ranges in OpenCV (0-180):
    #   Blue: 100-130
    #   Blue-Green: 80-100
    #   Green: 50-80
    #   Yellow-Green: 35-50
    #   Yellow: 20-35
    #   Pale: low saturation + high value

    if s < 25 and v > 180:
        return "PALE", 5.0

    if h >= 100:
        return "BLUE", 0.0
    elif h >= 80:
        return "BLUE-GREEN", 1.0
    elif h >= 50:
        return "GREEN", 2.0
    elif h >= 35:
        return "YELLOW-GREEN", 3.0
    elif h >= 20:
        return "YELLOW", 4.0
    else:
        return "PALE", 5.0


def _refine_state_position(rgb, hsv, dataset, nearest_idx):
    """Refine the continuous state position between calibration points.

    Uses the nearest two calibration points to interpolate a
    continuous position within the BCG state scale.
    """
    from .color_analysis import color_distance_combined

    if len(dataset.points) < 2:
        return float(nearest_idx)

    nearest_point = dataset.points[nearest_idx]
    nearest_state = nearest_point.color_state.upper()
    nearest_state_idx = BCG_STATES.index(nearest_state) if nearest_state in BCG_STATES else nearest_idx

    # Find the second-closest point with a different state
    best_second = None
    best_second_dist = float("inf")
    for i, p in enumerate(dataset.points):
        if i == nearest_idx:
            continue
        d = color_distance_combined(rgb, p.rgb, hsv, p.hsv)
        if d < best_second_dist:
            best_second_dist = d
            best_second = (i, p)

    if best_second is None:
        return float(nearest_state_idx)

    second_idx, second_point = best_second
    second_state = second_point.color_state.upper()
    second_state_idx = BCG_STATES.index(second_state) if second_state in BCG_STATES else second_idx

    # Interpolate between the two state indices based on color distance
    d1 = color_distance_combined(rgb, nearest_point.rgb, hsv, nearest_point.hsv)
    d2 = color_distance_combined(rgb, second_point.rgb, hsv, second_point.hsv)
    total = d1 + d2
    if total < 0.001:
        return float(nearest_state_idx)

    # Position between the two states
    w2 = d1 / total
    w1 = d2 / total
    pos = nearest_state_idx * w1 + second_state_idx * w2

    return round(pos, 2)
