"""calibration.py — Calibration data management for colorimetric analysis.

Stores, loads, interpolates, and manages calibration datasets.
Each dataset maps measured colors to known concentrations for
a specific analyte (Sodium, Lactate).

CRITICAL DESIGN RULES:
- 50% is the experimentally measured baseline reference for both analytes.
- Each analyte (Sodium, Lactate) has its own independent baseline.
- Each analyte has its own independent calibration dataset.
- Baselines are captured from physical reference strips (multi-frame).
- Calibration points store multi-measurement statistics.
- Percentages come ONLY from physical calibration data.
- Color names (BCG states) are descriptive only — they never drive %.
- Model selection is based on validation error, not convenience.
- Calibration versions are tracked and can be locked.
- MAE, RMSE, R², bias are computed for validation.
"""
import json
import math
import numpy as np
import os
import time
from pathlib import Path


_DEFAULT_CONFIG_DIR = Path(__file__).parent / "config"
_DEFAULT_CAL_FILE = _DEFAULT_CONFIG_DIR / "calibration.json"

# BCG states in expected reaction direction (BLUE baseline → YELLOW/PALE)
BCG_REACTION_ORDER = [
    "BLUE", "BLUE-GREEN", "GREEN", "YELLOW-GREEN", "YELLOW", "PALE"
]

EXPECTED_HUE_DIRECTION = "decreasing"


class CalibrationPoint:
    """Single calibration reference point with multi-measurement statistics."""

    def __init__(self, percentage, rgb, hsv, color_state,
                 concentration=None, version=1, timestamp=None,
                 lab=None, rgb_std=None, hsv_std=None,
                 frame_count=1, valid_pixels=0,
                 rgb_median=None, hsv_median=None):
        self.percentage = float(percentage)
        self.rgb = [float(v) for v in rgb[:3]]
        self.hsv = [float(v) for v in hsv[:3]]
        self.lab = [float(v) for v in lab[:3]] if lab else [0.0, 0.0, 0.0]
        self.color_state = color_state
        self.concentration = concentration
        self.version = int(version)
        self.timestamp = timestamp or time.time()
        self.rgb_std = [float(v) for v in rgb_std[:3]] if rgb_std else [0.0, 0.0, 0.0]
        self.hsv_std = [float(v) for v in hsv_std[:3]] if hsv_std else [0.0, 0.0, 0.0]
        self.frame_count = int(frame_count)
        self.valid_pixels = int(valid_pixels)
        self.rgb_median = [float(v) for v in rgb_median[:3]] if rgb_median else self.rgb
        self.hsv_median = [float(v) for v in hsv_median[:3]] if hsv_median else self.hsv

    @property
    def hue(self):
        return self.hsv[0] if self.hsv else 0

    @property
    def saturation(self):
        return self.hsv[1] if len(self.hsv) > 1 else 0

    @property
    def value(self):
        return self.hsv[2] if len(self.hsv) > 2 else 0

    def to_dict(self):
        return {
            "percentage": self.percentage,
            "rgb": self.rgb,
            "hsv": self.hsv,
            "lab": self.lab,
            "color_state": self.color_state,
            "concentration": self.concentration,
            "version": self.version,
            "timestamp": self.timestamp,
            "rgb_std": self.rgb_std,
            "hsv_std": self.hsv_std,
            "frame_count": self.frame_count,
            "valid_pixels": self.valid_pixels,
            "rgb_median": self.rgb_median,
            "hsv_median": self.hsv_median,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            percentage=d["percentage"],
            rgb=d["rgb"],
            hsv=d["hsv"],
            color_state=d.get("color_state", "UNKNOWN"),
            concentration=d.get("concentration"),
            version=d.get("version", 1),
            timestamp=d.get("timestamp", 0),
            lab=d.get("lab"),
            rgb_std=d.get("rgb_std"),
            hsv_std=d.get("hsv_std"),
            frame_count=d.get("frame_count", 1),
            valid_pixels=d.get("valid_pixels", 0),
            rgb_median=d.get("rgb_median"),
            hsv_median=d.get("hsv_median"),
        )


class Baseline:
    """Captured 50% baseline reference for one analyte (Sodium or Lactate).

    Stores the experimentally measured color of the 50% reference strip.
    Captured from multiple frames with validation.
    The baseline anchors the 50% point of the calibration curve.
    """

    def __init__(self):
        self.is_set = False
        self.rgb = None       # [R, G, B] average
        self.hsv = None       # [H, S, V] average
        self.rgb_std = None   # [R, G, B] standard deviation
        self.hsv_std = None   # [H, S, V] standard deviation
        self.color_state = "UNKNOWN"
        self.frame_count = 0
        self.frame_variance = 0.0
        self.timestamp = None
        self.calibration_version = 1

    def capture_from_frames(self, frames, roi, mask=None):
        """Capture baseline from multiple frames.

        Args:
            frames: List of BGR numpy arrays.
            roi: (x, y, w, h) reaction area.
            mask: Optional analysis mask.

        Returns:
            dict with valid, message, baseline data.
        """
        from .color_analysis import extract_roi_color

        if not frames or roi is None:
            return {"valid": False, "message": "No frames or ROI provided"}

        results = []
        for frame in frames:
            r = extract_roi_color(frame, roi, mask)
            if r is not None and r["valid_pixels"] >= 20:
                results.append(r)

        if len(results) < 2:
            return {
                "valid": False,
                "message": f"Insufficient valid frames ({len(results)}/2 minimum)",
            }

        # Check frame consistency
        all_rgb = np.array([r["rgb"] for r in results])
        frame_std = np.std(all_rgb, axis=0)
        avg_std = float(np.mean(frame_std))

        if avg_std > 30:
            return {
                "valid": False,
                "message": f"Frame inconsistency too high (std={avg_std:.1f}) — lighting unstable",
            }

        # Check coverage
        avg_coverage = np.mean([r["coverage"] for r in results])
        if avg_coverage < 0.3:
            return {
                "valid": False,
                "message": f"Low ROI coverage ({avg_coverage*100:.0f}%) — reposition strip",
            }

        # Check for glare
        avg_glare = np.mean([r["rgb"][0] > 240 and r["hsv"][1] < 30
                             for r in results if r["hsv"][1] < 30])
        if avg_glare > 0.3:
            return {
                "valid": False,
                "message": "Excessive glare detected — adjust lighting",
            }

        # Calculate baseline averages
        avg_rgb = np.mean([r["rgb"] for r in results], axis=0).tolist()
        avg_hsv = np.mean([r["hsv"] for r in results], axis=0).tolist()
        std_rgb = np.mean([r["rgb_std"] for r in results], axis=0).tolist()
        std_hsv = np.mean([r["hsv_std"] for r in results], axis=0).tolist()

        # Classify BCG state
        from .bcg_classifier import classify_bcg_simple
        color_state, _ = classify_bcg_simple(avg_rgb, avg_hsv)

        # Set baseline
        self.is_set = True
        self.rgb = [round(v, 2) for v in avg_rgb]
        self.hsv = [round(v, 2) for v in avg_hsv]
        self.rgb_std = [round(v, 2) for v in std_rgb]
        self.hsv_std = [round(v, 2) for v in std_hsv]
        self.color_state = color_state
        self.frame_count = len(results)
        self.frame_variance = round(avg_std, 3)
        self.timestamp = time.time()

        return {
            "valid": True,
            "message": f"Baseline captured from {len(results)} frames",
            "baseline": self.to_dict(),
        }

    def check_drift(self, current_rgb, current_hsv, threshold=25.0):
        """Check if current measurement has drifted from baseline environment.

        Uses the baseline std as reference for expected variance.
        Returns dict with drifted bool and message.
        """
        if not self.is_set or self.rgb is None:
            return {"drifted": False, "message": "No baseline set"}

        from .color_analysis import color_distance_combined
        dist = color_distance_combined(current_rgb, self.rgb, current_hsv, self.hsv)

        # Allow some drift based on baseline variance
        expected_range = threshold + (self.frame_variance * 2 if self.frame_variance else 0)

        if dist > expected_range * 3:
            return {
                "drifted": True,
                "message": f"Environment drift detected (distance={dist:.1f}, expected<{expected_range*3:.0f})",
                "distance": round(dist, 2),
            }

        return {"drifted": False, "message": "Environment stable", "distance": round(dist, 2)}

    def normalize_color(self, rgb, hsv):
        """Calculate baseline-relative color representation.

        Returns both raw and relative values:
        relative_rgb[i] = rgb[i] - baseline_rgb[i]
        relative_hsv[i] = hsv[i] - baseline_hsv[i]  (with hue wrapping)

        DO NOT use relative values to replace raw values.
        Store both.
        """
        if not self.is_set or self.rgb is None or self.hsv is None:
            return {
                "raw_rgb": rgb,
                "raw_hsv": hsv,
                "relative_rgb": None,
                "relative_hsv": None,
            }

        rel_rgb = [rgb[i] - self.rgb[i] for i in range(3)]

        # Hue is circular (0-180 in OpenCV)
        rel_h = hsv[0] - self.hsv[0]
        if rel_h > 90:
            rel_h -= 180
        elif rel_h < -90:
            rel_h += 180
        rel_s = hsv[1] - self.hsv[1]
        rel_v = hsv[2] - self.hsv[2]
        rel_hsv = [rel_h, rel_s, rel_v]

        return {
            "raw_rgb": rgb,
            "raw_hsv": hsv,
            "relative_rgb": [round(v, 2) for v in rel_rgb],
            "relative_hsv": [round(v, 2) for v in rel_hsv],
        }

    def reset(self):
        """Clear the baseline."""
        self.__init__()

    def to_dict(self):
        return {
            "is_set": self.is_set,
            "rgb": self.rgb,
            "hsv": self.hsv,
            "rgb_std": self.rgb_std,
            "hsv_std": self.hsv_std,
            "color_state": self.color_state,
            "frame_count": self.frame_count,
            "frame_variance": self.frame_variance,
            "timestamp": self.timestamp,
            "calibration_version": self.calibration_version,
        }

    @classmethod
    def from_dict(cls, d):
        b = cls()
        if not d or not d.get("is_set"):
            return b
        b.is_set = True
        b.rgb = d.get("rgb")
        b.hsv = d.get("hsv")
        b.rgb_std = d.get("rgb_std")
        b.hsv_std = d.get("hsv_std")
        b.color_state = d.get("color_state", "UNKNOWN")
        b.frame_count = d.get("frame_count", 0)
        b.frame_variance = d.get("frame_variance", 0)
        b.timestamp = d.get("timestamp")
        b.calibration_version = d.get("calibration_version", 1)
        return b


class CalibrationDataset:
    """Calibration dataset for a single analyte (Sodium or Lactate).

    Stores its own baseline and calibration points.
    Points are sorted by percentage (ascending).
    The baseline uses a 50% BLUE reference strip as anchor.
    Higher percentages correspond to progressively yellower/paler colors.

    INTERPOLATION follows the percentage-ordered trajectory,
    NOT arbitrary RGB channel sorting.
    """

    def __init__(self, analyte_name):
        self.analyte_name = analyte_name
        self.points = []  # list of CalibrationPoint, sorted by percentage
        self.baseline = Baseline()  # captured 50% baseline for this analyte

    def add_point(self, point):
        """Add a calibration point, maintaining sort order by percentage."""
        self.points.append(point)
        self.points.sort(key=lambda p: p.percentage)

    def remove_point(self, index):
        if 0 <= index < len(self.points):
            return self.points.pop(index)
        return None

    def update_point(self, index, point):
        if 0 <= index < len(self.points):
            self.points[index] = point
            self.points.sort(key=lambda p: p.percentage)

    def is_empty(self):
        return len(self.points) < 2

    # ── Direction Validation ────────────────────────────────────────

    def validate_direction(self):
        """Validate that calibration direction is BLUE → YELLOW/PALE.

        Checks:
        1. 0% point should have higher hue (bluer) than higher % points.
        2. Hue should generally decrease as percentage increases.
        3. Detect reversed calibration.

        Returns:
            dict with:
                valid: bool
                message: str
                direction: str ("correct"|"reversed"|"indeterminate")
                hue_trend: float (negative = correct BLUE→YELLOW direction)
        """
        if len(self.points) < 2:
            return {
                "valid": False,
                "message": "Need at least 2 calibration points to validate direction",
                "direction": "indeterminate",
                "hue_trend": 0.0,
            }

        # Sort by percentage (already sorted)
        hues = [p.hue for p in self.points]
        pcts = [p.percentage for p in self.points]

        # Check hue trend: should decrease as percentage increases
        hue_diffs = []
        for i in range(1, len(hues)):
            # Handle hue circularity (0/180 boundary)
            dh = hues[i] - hues[i - 1]
            if abs(dh) > 90:
                # Wrap around: e.g., 170 → 10 means +20 increase
                dh = (dh + 180) % 360 - 180
            hue_diffs.append(dh)

        avg_hue_diff = sum(hue_diffs) / len(hue_diffs) if hue_diffs else 0

        # Check BCG state ordering
        state_indices = []
        for p in self.points:
            state_str = p.color_state.upper() if p.color_state else "UNKNOWN"
            if state_str in BCG_REACTION_ORDER:
                state_indices.append(BCG_REACTION_ORDER.index(state_str))
            else:
                state_indices.append(-1)

        state_reversed = False
        if all(s >= 0 for s in state_indices):
            # Check if states decrease in index as percentage increases
            state_diffs = [state_indices[i] - state_indices[i-1]
                           for i in range(1, len(state_indices))]
            if all(d < 0 for d in state_diffs):
                state_reversed = True

        # Determine direction
        if avg_hue_diff > 1.0:
            # Hue increasing with % = reversed (YELLOW→BLUE)
            direction = "reversed"
            valid = False
            message = (
                f"CALIBRATION DIRECTION INVALID — "
                f"EXPECTED: BLUE → YELLOW/PALE — "
                f"Hue increases {avg_hue_diff:.1f}° per step "
                f"(should decrease)"
            )
        elif state_reversed:
            direction = "reversed"
            valid = False
            message = (
                f"CALIBRATION DIRECTION INVALID — "
                f"EXPECTED: BLUE → YELLOW/PALE — "
                f"BCG states are in reversed order"
            )
        elif avg_hue_diff < -0.5:
            direction = "correct"
            valid = True
            message = f"Calibration direction valid (hue trend: {avg_hue_diff:.1f}°/step)"
        else:
            # Hue barely changes — could be flat calibration
            direction = "indeterminate"
            valid = True  # Allow but warn
            message = (
                f"Calibration direction indeterminate "
                f"(hue trend: {avg_hue_diff:.1f}°/step) — verify manually"
            )

        return {
            "valid": valid,
            "message": message,
            "direction": direction,
            "hue_trend": round(avg_hue_diff, 2),
        }

    def validate_baseline(self):
        """Verify that the lowest calibration point is the 50% BLUE baseline.

        Returns:
            dict with valid, message, baseline_color_state
        """
        if not self.points:
            return {"valid": False, "message": "No calibration points"}

        zero_pt = self.points[0]
        if zero_pt.percentage != 50:
            return {
                "valid": False,
                "message": f"Lowest calibration point is {zero_pt.percentage}%, expected 50% baseline",
                "baseline_color_state": zero_pt.color_state,
            }

        state = (zero_pt.color_state or "").upper()
        if state not in ("BLUE", "BLUE-GREEN", "UNKNOWN"):
            return {
                "valid": False,
                "message": (
                    f"50% baseline color state is '{state}', expected BLUE. "
                    f"The 50% reference should correspond to the BLUE baseline."
                ),
                "baseline_color_state": zero_pt.color_state,
            }

        return {
            "valid": True,
            "message": f"Baseline anchor OK: 50% = {state}",
            "baseline_color_state": zero_pt.color_state,
        }

    # ── Validation Metrics ──────────────────────────────────────────

    def validate_self(self):
        """Test every calibration point against the model (resubstitution).

        Returns MAE, RMSE, R², bias, max error, and per-point details.
        """
        if len(self.points) < 2:
            return {"error": "Need at least 2 points", "points": []}

        results = []
        errors = []
        predictions = []
        actuals = []
        for i, pt in enumerate(self.points):
            others = [p for j, p in enumerate(self.points) if j != i]
            pred, conf = self._interpolate_with_points(
                pt.rgb, pt.hsv, others, baseline=self.baseline)
            if pred is not None:
                err = pred - pt.percentage
                abs_err = abs(err)
                errors.append(abs_err)
                predictions.append(pred)
                actuals.append(pt.percentage)
                results.append({
                    "known_pct": pt.percentage,
                    "predicted_pct": round(pred, 1),
                    "error": round(abs_err, 1),
                    "signed_error": round(err, 1),
                    "color_state": pt.color_state,
                })
            else:
                results.append({
                    "known_pct": pt.percentage,
                    "predicted_pct": None,
                    "error": None,
                    "signed_error": None,
                    "color_state": pt.color_state,
                })

        if not errors:
            return {"mae": None, "rmse": None, "r_squared": None,
                    "bias": None, "max_error": None, "points": results}

        mae = sum(errors) / len(errors)
        rmse = math.sqrt(sum(e**2 for e in errors) / len(errors))
        max_err = max(errors)

        # R² (coefficient of determination)
        actuals_arr = np.array(actuals)
        preds_arr = np.array(predictions)
        ss_res = np.sum((actuals_arr - preds_arr) ** 2)
        ss_tot = np.sum((actuals_arr - np.mean(actuals_arr)) ** 2)
        r_squared = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

        # Bias: mean signed error (positive = overestimates, negative = underestimates)
        signed_errors = [predictions[i] - actuals[i] for i in range(len(predictions))]
        bias = sum(signed_errors) / len(signed_errors)

        # Systematic bias flag
        bias_flag = None
        if abs(bias) > 5:
            direction = "OVERESTIMATES" if bias > 0 else "UNDERESTIMATES"
            bias_flag = f"SYSTEMATIC BIAS DETECTED — device {direction} by {abs(bias):.1f}% on average"

        return {
            "mae": round(mae, 2),
            "rmse": round(rmse, 2),
            "r_squared": round(float(r_squared), 4),
            "bias": round(bias, 2),
            "bias_flag": bias_flag,
            "max_error": round(max_err, 2),
            "n_points": len(errors),
            "points": results,
            "quality": self._validation_quality(mae, rmse, r_squared),
        }

    def _validation_quality(self, mae, rmse, r_squared):
        """Classify calibration quality based on validation metrics."""
        if r_squared is None:
            return "INSUFFICIENT DATA"
        if mae < 5 and r_squared > 0.95:
            return "EXCELLENT"
        if mae < 10 and r_squared > 0.90:
            return "GOOD"
        if mae < 20 and r_squared > 0.80:
            return "ACCEPTABLE"
        if mae < 30:
            return "POOR"
        return "INSUFFICIENT"

    def cross_validate_leave_one_out(self):
        """Leave-one-out cross-validation.

        For each point, remove it, interpolate using remaining points,
        and compare predicted vs known.

        Returns dict with MAE, RMSE, R², bias, per-point results.
        """
        if len(self.points) < 3:
            return {"error": "Need at least 3 points for cross-validation",
                    "points": []}

        results = []
        errors = []
        predictions = []
        actuals = []
        for i, pt in enumerate(self.points):
            others = [p for j, p in enumerate(self.points) if j != i]
            pred, conf = self._interpolate_with_points(
                pt.rgb, pt.hsv, others, baseline=self.baseline)
            if pred is not None:
                err = pred - pt.percentage
                abs_err = abs(err)
                errors.append(abs_err)
                predictions.append(pred)
                actuals.append(pt.percentage)
                results.append({
                    "held_out_pct": pt.percentage,
                    "predicted_pct": round(pred, 1),
                    "error": round(abs_err, 1),
                    "signed_error": round(err, 1),
                    "confidence": round(conf, 3),
                    "color_state": pt.color_state,
                })

        if not errors:
            return {"mae": None, "rmse": None, "r_squared": None,
                    "bias": None, "max_error": None, "points": results}

        mae = sum(errors) / len(errors)
        rmse = math.sqrt(sum(e**2 for e in errors) / len(errors))
        max_err = max(errors)

        actuals_arr = np.array(actuals)
        preds_arr = np.array(predictions)
        ss_res = np.sum((actuals_arr - preds_arr) ** 2)
        ss_tot = np.sum((actuals_arr - np.mean(actuals_arr)) ** 2)
        r_squared = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

        signed_errors = [predictions[i] - actuals[i] for i in range(len(predictions))]
        bias = sum(signed_errors) / len(signed_errors)

        return {
            "mae": round(mae, 2),
            "rmse": round(rmse, 2),
            "r_squared": round(float(r_squared), 4),
            "bias": round(bias, 2),
            "max_error": round(max_err, 2),
            "n_points": len(results),
            "points": results,
            "quality": self._validation_quality(mae, rmse, r_squared),
        }

    # ── Interpolation (monotonic, percentage-trajectory based) ──────

    def find_closest(self, rgb, hsv):
        """Find nearest calibration point by combined color distance.

        Returns: (index, point, distance)
        """
        from .color_analysis import color_distance_combined

        if not self.points:
            return None, None, float("inf")

        best_idx = 0
        best_dist = float("inf")
        for i, p in enumerate(self.points):
            d = color_distance_combined(rgb, p.rgb, hsv, p.hsv)
            if d < best_dist:
                best_dist = d
                best_idx = i

        return best_idx, self.points[best_idx], best_dist

    def interpolate(self, rgb, hsv):
        """Interpolate percentage from measured color.

        Interpolation follows the PERCENTAGE-ORDERED calibration trajectory.
        Uses baseline-relative colors when baseline is available.
        The two nearest calibration points (by color distance) are found,
        then percentage is linearly interpolated between them based on
        their positions along the reaction trajectory.

        Returns:
            (percentage, confidence_factor)
            confidence_factor 0-1: 1=exact match, 0=unreliable.
        """
        valid, msg = self._check_valid_for_measurement()
        if not valid:
            return None, 0.0

        return self._interpolate_with_points(
            rgb, hsv, self.points, baseline=self.baseline
        )

    def _interpolate_with_points(self, rgb, hsv, points, baseline=None):
        """Internal interpolation using a given set of points.

        Args:
            rgb: Measured RGB.
            hsv: Measured HSV.
            points: Calibration points.
            baseline: Optional Baseline for relative color comparison.
        """
        from .color_analysis import color_distance_combined

        if len(points) < 1:
            return None, 0.0

        if len(points) == 1:
            p = points[0]
            d = color_distance_combined(rgb, p.rgb, hsv, p.hsv)
            conf = max(0, 1.0 - d / 150.0)
            return p.percentage, conf

        # Compute distances to ALL calibration points
        dists = []
        for i, p in enumerate(points):
            d = color_distance_combined(rgb, p.rgb, hsv, p.hsv)

            # If baseline available, also compute relative color distance
            if baseline and baseline.is_set:
                norm = baseline.normalize_color(rgb, hsv)
                p_norm = baseline.normalize_color(p.rgb, p.hsv)
                if norm["relative_rgb"] is not None and p_norm["relative_rgb"] is not None:
                    d_rel = color_distance_combined(
                        norm["relative_rgb"], p_norm["relative_rgb"],
                        norm["relative_hsv"], p_norm["relative_hsv"],
                    )
                    # Blend raw and relative distances
                    d = d * 0.5 + d_rel * 0.5

            dists.append((d, i))

        dists.sort(key=lambda x: x[0])

        # Exact match
        best_d, best_i = dists[0]
        if best_d < 3.0:
            return points[best_i].percentage, 0.95

        # Find the two nearest points
        d1, i1 = dists[0]
        d2, i2 = dists[1]
        p1 = points[i1]
        p2 = points[i2]

        total_d = d1 + d2
        if total_d < 0.001:
            return p1.percentage, 0.8

        # Linear interpolation: weight inversely proportional to distance
        w1 = d2 / total_d  # weight for p1 (further = less weight)
        w2 = d1 / total_d  # weight for p2 (closer = more weight)

        interpolated = p1.percentage * w1 + p2.percentage * w2

        # Clamp to calibration range (no extrapolation beyond reliable range)
        min_pct = min(p.percentage for p in points)
        max_pct = max(p.percentage for p in points)
        is_extrapolated = interpolated < min_pct or interpolated > max_pct
        interpolated = max(min_pct, min(max_pct, interpolated))

        # Confidence factors
        # 1. How close is the nearest point?
        closeness = max(0, 1.0 - d1 / 100.0)
        # 2. How far apart are the bracketing points? (wider = better interpolation)
        bracket_width = abs(p1.percentage - p2.percentage)
        bracket_factor = min(1.0, bracket_width / 25.0 + 0.3)
        # 3. How many points do we have? (more = more reliable)
        coverage_factor = min(1.0, len(points) / 5.0)
        # 4. Penalty for extrapolation
        extra_penalty = 0.5 if is_extrapolated else 1.0

        conf = closeness * 0.5 + bracket_factor * 0.25 + coverage_factor * 0.25
        conf *= extra_penalty

        return round(interpolated, 1), round(min(1.0, max(0.0, conf)), 3)

    def _check_valid_for_measurement(self):
        """Check if dataset is valid for producing measurements."""
        if not self.baseline.is_set:
            return False, f"{self.analyte_name.upper()} BASELINE REQUIRED"

        if len(self.points) < 2:
            return False, f"Insufficient calibration points ({len(self.points)}/2 minimum)"

        direction = self.validate_direction()
        if not direction["valid"]:
            return False, direction["message"]

        baseline_val = self.validate_baseline()
        if not baseline_val["valid"]:
            return False, baseline_val["message"]

        return True, "Calibration valid"

    # ── Coverage ────────────────────────────────────────────────────

    def coverage_range(self):
        if not self.points:
            return None
        return (self.points[0].percentage, self.points[-1].percentage)

    def is_outside_range(self, rgb, hsv):
        """Check if a measured color is significantly outside the calibrated range."""
        from .color_analysis import color_distance_combined

        if len(self.points) < 2:
            return True

        # Check distance to nearest point
        _, _, nearest_dist = self.find_closest(rgb, hsv)

        # Check if it's between two points or outside
        dists = [(color_distance_combined(rgb, p.rgb, hsv, p.hsv), p)
                 for p in self.points]
        dists.sort(key=lambda x: x[0])

        # If nearest point is very far, it's outside range
        if nearest_dist > 120:
            return True

        return False

    # ── Serialization ───────────────────────────────────────────────

    def to_list(self):
        return [p.to_dict() for p in self.points]

    @classmethod
    def from_list(cls, analyte_name, data_list):
        ds = cls(analyte_name)
        for d in data_list:
            ds.add_point(CalibrationPoint.from_dict(d))
        return ds


class CalibrationManager:
    """Manages calibration data for Sodium and Lactate.

    Loads from and saves to a JSON config file.
    Enforces independent datasets per analyte.
    Each analyte has its own independent baseline and calibration points.
    Supports calibration versioning and locking.
    """

    def __init__(self, config_path=None):
        self._path = Path(config_path) if config_path else _DEFAULT_CAL_FILE
        self.sodium = CalibrationDataset("sodium")
        self.lactate = CalibrationDataset("lactate")
        self.version = 1
        self.locked_version = None  # None = not locked
        self._load()

    def _load(self):
        if not self._path.exists():
            return
        try:
            with open(self._path, "r") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return

        self.version = data.get("version", 1)
        self.locked_version = data.get("locked_version")
        if "sodium" in data:
            self.sodium = CalibrationDataset.from_list("sodium", data["sodium"])
        if "lactate" in data:
            self.lactate = CalibrationDataset.from_list("lactate", data["lactate"])

        # Load baselines
        if "sodium_baseline" in data and data["sodium_baseline"]:
            self.sodium.baseline = Baseline.from_dict(data["sodium_baseline"])
        if "lactate_baseline" in data and data["lactate_baseline"]:
            self.lactate.baseline = Baseline.from_dict(data["lactate_baseline"])

    def save(self):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "version": self.version,
            "locked_version": self.locked_version,
            "sodium": self.sodium.to_list(),
            "lactate": self.lactate.to_list(),
            "sodium_baseline": self.sodium.baseline.to_dict(),
            "lactate_baseline": self.lactate.baseline.to_dict(),
        }
        with open(self._path, "w") as f:
            json.dump(data, f, indent=2)

    def lock_calibration(self):
        """Lock current calibration version. Normal testing uses locked version."""
        self.locked_version = self.version
        self.save()

    def unlock_calibration(self):
        """Unlock calibration (allow changes)."""
        self.locked_version = None
        self.save()

    @property
    def is_locked(self):
        return self.locked_version is not None

    def reset_baseline(self, analyte):
        """Reset baseline for one analyte without affecting the other."""
        ds = self.get_dataset(analyte)
        if ds is None:
            return False
        ds.baseline.reset()
        self.version += 1
        ds.baseline.calibration_version = self.version
        self.save()
        return True

    def get_dataset(self, analyte):
        if analyte.lower() == "sodium":
            return self.sodium
        elif analyte.lower() == "lactate":
            return self.lactate
        return None

    def validate_all(self):
        """Full validation of both datasets."""
        return {
            "sodium": {
                "direction": self.sodium.validate_direction(),
                "baseline": self.sodium.validate_baseline(),
                "self_test": self.sodium.validate_self(),
                "cross_validation": self.sodium.cross_validate_leave_one_out(),
            },
            "lactate": {
                "direction": self.lactate.validate_direction(),
                "baseline": self.lactate.validate_baseline(),
                "self_test": self.lactate.validate_self(),
                "cross_validation": self.lactate.cross_validate_leave_one_out(),
            },
        }

    def summary(self):
        s_val = self.sodium.validate_self()
        l_val = self.lactate.validate_self()
        return {
            "version": self.version,
            "locked_version": self.locked_version,
            "is_locked": self.is_locked,
            "sodium_points": len(self.sodium.points),
            "sodium_range": self.sodium.coverage_range(),
            "sodium_baseline": self.sodium.baseline.is_set,
            "sodium_valid": self.sodium.validate_direction()["valid"]
                if len(self.sodium.points) >= 2 else None,
            "sodium_mae": s_val.get("mae"),
            "sodium_r_squared": s_val.get("r_squared"),
            "sodium_bias": s_val.get("bias"),
            "lactate_points": len(self.lactate.points),
            "lactate_range": self.lactate.coverage_range(),
            "lactate_baseline": self.lactate.baseline.is_set,
            "lactate_valid": self.lactate.validate_direction()["valid"]
                if len(self.lactate.points) >= 2 else None,
            "lactate_mae": l_val.get("mae"),
            "lactate_r_squared": l_val.get("r_squared"),
            "lactate_bias": l_val.get("bias"),
        }
