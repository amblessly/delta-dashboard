"""pipeline_test.py — End-to-end test for the colorimetric pipeline.

Tests the complete isolated pipeline including:
- Color analysis
- Strip detection
- BCG classification
- Calibration with direction validation
- Monotonic interpolation
- Sodium/Lactate measurement
- Confidence scoring
- Full session pipeline
"""
import sys
import os
import json
import time
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from colorimetric.camera import DummyCamera
from colorimetric.strip_detector import StripDetector
from colorimetric.color_analysis import (
    extract_roi_color, analyze_multi_frame,
    color_distance_rgb, color_distance_lab, color_distance_combined,
)
from colorimetric.bcg_classifier import classify_bcg_simple, BCG_STATES
from colorimetric.calibration import (
    CalibrationManager, CalibrationPoint, CalibrationDataset, Baseline,
    BCG_REACTION_ORDER,
)
from colorimetric.confidence import calculate_confidence, format_confidence
from colorimetric.sodium import measure_sodium
from colorimetric.lactate import measure_lactate
from colorimetric.session import ColorimetricSession, save_result, load_results


def test_color_analysis():
    """Test RGB/HSV/Lab extraction, robust filtering, and color distance."""
    import numpy as np
    print("[TEST] color_analysis...", end=" ")

    roi_frame = np.zeros((200, 200, 3), dtype=np.uint8)
    roi_frame[30:170, 30:170] = (200, 50, 30)
    roi = (30, 30, 140, 140)
    result = extract_roi_color(roi_frame, roi)
    if result is not None:
        assert result["rgb"][0] > 0
        assert "lab" in result, "Lab color space should be present"
        assert "rgb_median" in result, "Median RGB should be present"
        assert "glare_fraction" in result, "Glare fraction should be present"
        assert "color_uniformity" in result, "Color uniformity should be present"

    d1 = color_distance_rgb([100, 50, 30], [100, 50, 30])
    assert d1 == 0.0
    d2 = color_distance_rgb([100, 50, 30], [200, 100, 60])
    assert d2 > 0
    d3 = color_distance_combined([100, 50, 30], [200, 100, 60])
    assert d3 > 0

    from colorimetric.color_analysis import color_distance_lab_direct
    d4 = color_distance_lab_direct([50, 128, 128], [50, 128, 128])
    assert d4 == 0.0
    d5 = color_distance_lab_direct([50, 128, 128], [80, 160, 160])
    assert d5 > 0

    print("PASS")


def test_strip_detector():
    """Test strip detection with synthetic frames."""
    import numpy as np
    print("[TEST] strip_detector...", end=" ")

    detector = StripDetector(min_strip_area=500)
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    frame[100:380, 200:440] = (240, 240, 240)
    result = detector.detect(frame)
    assert result is not None
    assert "detected" in result
    assert "roi_quality" in result, "ROI quality should be present"
    assert "position_check" in result, "Position check should be present"

    result_dual = detector.detect_dual_zones(frame)
    assert "sodium_roi" in result_dual
    assert "lactate_roi" in result_dual
    print("PASS")


def test_bcg_classifier():
    """Test BCG color state classification."""
    print("[TEST] bcg_classifier...", end=" ")

    state, idx = classify_bcg_simple([0, 0, 200], [120, 200, 200])
    assert state in BCG_STATES
    assert 0 <= idx <= 5

    ds = CalibrationDataset("test")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))

    from colorimetric.bcg_classifier import classify_bcg_from_calibration
    bcg = classify_bcg_from_calibration([30, 50, 180], [110, 200, 180], ds)
    assert bcg["state"] == "BLUE"
    assert bcg["nearest_point"] is not None
    print("PASS")


def test_calibration():
    """Test calibration data management and interpolation."""
    print("[TEST] calibration...", end=" ")

    with tempfile.TemporaryDirectory() as tmpdir:
        cal_file = os.path.join(tmpdir, "test_cal.json")
        mgr = CalibrationManager(cal_file)

        mgr.sodium.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
        mgr.sodium.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
        mgr.sodium.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))

        mgr.lactate.add_point(CalibrationPoint(50, [150, 30, 30], [170, 200, 150], "BLUE"))
        mgr.lactate.add_point(CalibrationPoint(100, [30, 180, 30], [60, 200, 180], "YELLOW"))

        mgr.sodium.baseline.is_set = True
        mgr.sodium.baseline.rgb = [30.0, 50.0, 180.0]
        mgr.sodium.baseline.hsv = [110.0, 200.0, 180.0]
        mgr.sodium.baseline.color_state = "BLUE"

        mgr.save()
        mgr2 = CalibrationManager(cal_file)
        assert len(mgr2.sodium.points) == 3
        assert len(mgr2.lactate.points) == 2

        pct, conf = mgr.sodium.interpolate([30, 100, 140], [85, 200, 165])
        assert pct is not None
        assert 0 <= pct <= 100

        idx, pt, dist = mgr.sodium.find_closest([30, 50, 180], [110, 200, 180])
        assert pt is not None
        assert pt.percentage == 50

        s = mgr.summary()
        assert s["sodium_points"] == 3
    print("PASS")


def test_calibration_direction_validation():
    """Test that calibration direction validation detects correct vs reversed."""
    print("[TEST] calibration_direction...", end=" ")

    # CORRECT direction: BLUE (50%) → GREEN (75%) → YELLOW (100%)
    # Hue decreases: 110 → 60 → 30
    ds_correct = CalibrationDataset("test")
    ds_correct.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds_correct.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds_correct.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))

    v = ds_correct.validate_direction()
    assert v["valid"], f"Correct direction should be valid: {v['message']}"
    assert v["direction"] == "correct"

    # REVERSED direction: YELLOW (50%) → GREEN (75%) → BLUE (100%)
    # Hue increases: 30 → 60 → 110
    ds_reversed = CalibrationDataset("test")
    ds_reversed.add_point(CalibrationPoint(50, [30, 180, 50], [30, 200, 180], "YELLOW"))
    ds_reversed.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds_reversed.add_point(CalibrationPoint(100, [30, 50, 180], [110, 200, 180], "BLUE"))

    v2 = ds_reversed.validate_direction()
    assert not v2["valid"], f"Reversed direction should be invalid: {v2['message']}"
    assert v2["direction"] == "reversed"

    # Baseline validation
    ds_bad_baseline = CalibrationDataset("test")
    ds_bad_baseline.add_point(CalibrationPoint(50, [30, 180, 50], [30, 200, 180], "YELLOW"))
    ds_bad_baseline.add_point(CalibrationPoint(100, [30, 50, 180], [110, 200, 180], "BLUE"))

    vb = ds_bad_baseline.validate_baseline()
    assert not vb["valid"], "50% baseline should not be YELLOW"

    # Good baseline
    vb2 = ds_correct.validate_baseline()
    assert vb2["valid"], f"50% baseline should be BLUE: {vb2['message']}"

    print("PASS")


def test_calibration_validation_metrics():
    """Test MAE/RMSE/R²/bias validation of calibration points."""
    print("[TEST] calibration_validation...", end=" ")

    ds = CalibrationDataset("test")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(62.5, [30, 100, 140], [85, 200, 165], "BLUE-GREEN"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(87.5, [30, 170, 70], [45, 200, 165], "YELLOW-GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    # Self-test (resubstitution)
    result = ds.validate_self()
    assert "mae" in result
    assert "rmse" in result
    assert "r_squared" in result, "R² should be present"
    assert "bias" in result, "Bias should be present"
    assert "max_error" in result
    assert result["mae"] is not None
    assert result["r_squared"] is not None
    assert result["mae"] < 30, f"Self-test MAE should be <30%, got {result['mae']}"
    assert result["quality"] in ("EXCELLENT", "GOOD", "ACCEPTABLE", "POOR", "INSUFFICIENT", "INSUFFICIENT DATA")

    # Cross-validation (leave-one-out)
    xval = ds.cross_validate_leave_one_out()
    assert "mae" in xval
    assert "r_squared" in xval, "Cross-val R² should be present"
    assert "bias" in xval, "Cross-val bias should be present"
    assert xval["mae"] is not None

    print("PASS")


def test_sodium_lactate():
    """Test Sodium and Lactate measurement with calibration validation."""
    print("[TEST] sodium_lactate...", end=" ")

    ds = CalibrationDataset("sodium")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    detection = {"detected": True, "confidence": 0.8, "reaction_roi": (0, 0, 100, 100)}

    color = {"rgb": [30, 100, 140], "hsv": [85, 200, 165], "coverage": 0.8, "consistency": 0.9}
    s_result = measure_sodium(color, detection, ds)
    assert s_result["percentage"] is not None
    assert s_result["color_state"] != "UNKNOWN"
    assert s_result["confidence"]["score"] > 0

    # Test with reversed calibration — should produce CALIBRATION ERROR
    ds_reversed = CalibrationDataset("sodium")
    ds_reversed.add_point(CalibrationPoint(50, [30, 180, 50], [30, 200, 180], "YELLOW"))
    ds_reversed.add_point(CalibrationPoint(100, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds_reversed.baseline.is_set = True
    ds_reversed.baseline.rgb = [30.0, 180.0, 50.0]
    ds_reversed.baseline.hsv = [30.0, 200.0, 180.0]
    ds_reversed.baseline.color_state = "YELLOW"

    s_rev = measure_sodium(color, detection, ds_reversed)
    assert s_rev["percentage"] is None, "Reversed calibration should not produce a result"
    assert "CALIBRATION ERROR" in s_rev["confidence"]["message"]

    # Test lactate independently
    l_ds = CalibrationDataset("lactate")
    l_ds.add_point(CalibrationPoint(50, [150, 30, 30], [170, 200, 150], "BLUE"))
    l_ds.add_point(CalibrationPoint(100, [30, 180, 30], [60, 200, 180], "YELLOW"))
    l_ds.baseline.is_set = True
    l_ds.baseline.rgb = [150.0, 30.0, 30.0]
    l_ds.baseline.hsv = [170.0, 200.0, 150.0]
    l_ds.baseline.color_state = "BLUE"

    l_result = measure_lactate(color, detection, l_ds)
    assert l_result is not None
    assert "percentage" in l_result

    print("PASS")


def test_blue_baseline_produces_low_values():
    """Test that BLUE baseline (50% ref) produces 50% for BLUE input."""
    print("[TEST] blue_baseline_50pct...", end=" ")

    ds = CalibrationDataset("sodium")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    detection = {"detected": True, "confidence": 0.9}

    # Feed BLUE color → should produce 50% (baseline anchor)
    blue_color = {"rgb": [30, 55, 175], "hsv": [108, 195, 180], "coverage": 0.9, "consistency": 0.95}
    result = measure_sodium(blue_color, detection, ds)
    assert result["percentage"] is not None
    assert 45 < result["percentage"] < 55, f"BLUE should give ~50%, got {result['percentage']}%"

    # Feed YELLOW color → should produce near 100%
    yellow_color = {"rgb": [32, 175, 55], "hsv": [32, 195, 175], "coverage": 0.9, "consistency": 0.95}
    result2 = measure_sodium(yellow_color, detection, ds)
    assert result2["percentage"] is not None
    assert result2["percentage"] > 90, f"YELLOW should give >90%, got {result2['percentage']}%"

    # Feed GREEN color → should produce ~75%
    green_color = {"rgb": [30, 148, 105], "hsv": [62, 195, 150], "coverage": 0.9, "consistency": 0.95}
    result3 = measure_sodium(green_color, detection, ds)
    assert result3["percentage"] is not None
    assert 65 < result3["percentage"] < 85, f"GREEN should give ~75%, got {result3['percentage']}%"

    print("PASS")


def test_interpolation_monotonic():
    """Test that interpolation is monotonic along the reaction trajectory."""
    print("[TEST] interpolation_monotonic...", end=" ")

    ds = CalibrationDataset("test")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(62.5, [30, 100, 140], [85, 200, 165], "BLUE-GREEN"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(87.5, [30, 170, 70], [45, 200, 165], "YELLOW-GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    # Feed progressively yellower colors — result should increase
    colors = [
        ([30, 55, 175], [108, 195, 180]),   # BLUE-ish
        ([30, 100, 140], [85, 195, 165]),    # BLUE-GREEN-ish
        ([30, 148, 105], [62, 195, 150]),    # GREEN-ish
        ([30, 168, 72], [47, 195, 165]),     # YELLOW-GREEN-ish
        ([30, 178, 52], [32, 195, 178]),     # YELLOW-ish
    ]

    prev_pct = -1
    for rgb, hsv in colors:
        pct, _ = ds.interpolate(rgb, hsv)
        assert pct is not None
        assert pct >= prev_pct, f"Interpolation should be monotonic: {prev_pct}% → {pct}%"
        prev_pct = pct

    print("PASS")


def test_outside_range():
    """Test that colors far outside calibration range are flagged."""
    print("[TEST] outside_range...", end=" ")

    ds = CalibrationDataset("test")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    # Very red color (not in calibration)
    assert ds.is_outside_range([200, 30, 30], [0, 200, 200])

    # BLUE should be inside range
    assert not ds.is_outside_range([30, 50, 180], [110, 200, 180])

    print("PASS")


def test_confidence():
    """Test confidence scoring."""
    print("[TEST] confidence...", end=" ")

    ds = CalibrationDataset("test")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    color = {"rgb": [30, 100, 140], "hsv": [85, 200, 165], "coverage": 0.8,
             "consistency": 0.9, "valid_pixels": 5000, "total_pixels": 10000,
             "rgb_std": [5, 5, 5], "hsv_std": [3, 3, 3]}
    detection = {"detected": True, "confidence": 0.9}

    conf = calculate_confidence(color, detection, ds)
    assert 0 <= conf["score"] <= 100
    assert conf["level"] in ("HIGH", "MEDIUM", "LOW", "VERY_LOW")
    assert len(conf["factors"]) > 0
    assert "calibration_direction" in conf["factors"]

    formatted = format_confidence(conf)
    assert "%" in formatted
    print("PASS")


def test_session():
    """Test full session pipeline with DummyCamera."""
    print("[TEST] session (full pipeline)...", end=" ")

    with tempfile.TemporaryDirectory() as tmpdir:
        cal_file = os.path.join(tmpdir, "cal.json")
        mgr = CalibrationManager(cal_file)

        cam = DummyCamera()
        cam.start()

        session = ColorimetricSession(cam, mgr)
        result = session.run_test()

        assert "session_id" in result
        assert "sodium" in result
        assert "lactate" in result
        assert "combined" in result
        assert result["duration_ms"] >= 0

        results_file = os.path.join(tmpdir, "results.json")
        save_result(result, results_file)
        loaded = load_results(results_file)
        assert len(loaded) == 1

        cam.stop()
    print("PASS")


def test_cross_validation():
    """Test leave-one-out cross-validation."""
    print("[TEST] cross_validation...", end=" ")

    ds = CalibrationDataset("test")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(62.5, [30, 100, 140], [85, 200, 165], "BLUE-GREEN"))
    ds.add_point(CalibrationPoint(75, [30, 150, 100], [60, 200, 150], "GREEN"))
    ds.add_point(CalibrationPoint(87.5, [30, 170, 70], [45, 200, 165], "YELLOW-GREEN"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))
    # Set baseline
    ds.baseline.is_set = True
    ds.baseline.rgb = [30.0, 50.0, 180.0]
    ds.baseline.hsv = [110.0, 200.0, 180.0]
    ds.baseline.color_state = "BLUE"

    result = ds.cross_validate_leave_one_out()
    assert result["mae"] is not None
    assert result["rmse"] is not None
    assert len(result["points"]) == 5

    for p in result["points"]:
        assert "held_out_pct" in p
        assert "predicted_pct" in p
        assert "error" in p
        assert p["error"] < 50, f"Holdout error too high: {p['error']}% for {p['held_out_pct']}%"

    print("PASS")


def test_baseline_capture():
    """Test baseline capture from multiple frames."""
    print("[TEST] baseline_capture...", end=" ")
    import numpy as np

    baseline = Baseline()
    assert not baseline.is_set

    # Create synthetic frames with consistent BLUE color
    frames = []
    for _ in range(5):
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        frame[10:90, 10:90] = (180, 50, 30)  # BGR BLUE
        frames.append(frame)

    roi = (10, 10, 80, 80)
    result = baseline.capture_from_frames(frames, roi)
    assert result["valid"], f"Capture failed: {result['message']}"
    assert baseline.is_set
    assert baseline.rgb is not None
    assert baseline.hsv is not None
    assert baseline.frame_count == 5
    assert baseline.color_state == "BLUE"
    print("PASS")


def test_baseline_independent():
    """Test Sodium and Lactate baselines are completely independent."""
    print("[TEST] baseline_independent...", end=" ")
    import numpy as np

    with tempfile.TemporaryDirectory() as tmpdir:
        cal_file = os.path.join(tmpdir, "cal.json")
        mgr = CalibrationManager(cal_file)

        # Capture Sodium baseline
        frames_s = []
        for _ in range(5):
            frame = np.zeros((100, 100, 3), dtype=np.uint8)
            frame[10:90, 10:90] = (180, 50, 30)
            frames_s.append(frame)
        result = mgr.sodium.baseline.capture_from_frames(frames_s, (10, 10, 80, 80))
        assert result["valid"]

        # Lactate baseline should still be unset
        assert not mgr.lactate.baseline.is_set

        # Reset Sodium baseline
        mgr.reset_baseline("sodium")
        assert not mgr.sodium.baseline.is_set
        assert not mgr.lactate.baseline.is_set  # still unset

        # Reset Lactate baseline (even though unset, should not affect Sodium)
        mgr.reset_baseline("lactate")
        assert not mgr.sodium.baseline.is_set

    print("PASS")


def test_baseline_required_for_measurement():
    """Test that missing baseline prevents measurement."""
    print("[TEST] baseline_required...", end=" ")

    ds = CalibrationDataset("sodium")
    ds.add_point(CalibrationPoint(50, [30, 50, 180], [110, 200, 180], "BLUE"))
    ds.add_point(CalibrationPoint(100, [30, 180, 50], [30, 200, 180], "YELLOW"))

    # No baseline set — interpolation should return None
    pct, conf = ds.interpolate([30, 100, 140], [85, 200, 165])
    assert pct is None, "Should not produce result without baseline"
    print("PASS")


def test_baseline_relative_color():
    """Test baseline-relative color normalization."""
    print("[TEST] baseline_relative...", end=" ")

    baseline = Baseline()
    baseline.is_set = True
    baseline.rgb = [30.0, 50.0, 180.0]
    baseline.hsv = [110.0, 200.0, 180.0]

    # Relative color of the baseline itself should be near zero
    norm = baseline.normalize_color([30.0, 50.0, 180.0], [110.0, 200.0, 180.0])
    assert norm["relative_rgb"] is not None
    assert all(abs(v) < 1.0 for v in norm["relative_rgb"]), f"Baseline relative RGB should be ~0: {norm['relative_rgb']}"
    assert all(abs(v) < 1.0 for v in norm["relative_hsv"]), f"Baseline relative HSV should be ~0: {norm['relative_hsv']}"

    # Yellow color should have different relative values
    norm_y = baseline.normalize_color([50.0, 180.0, 30.0], [30.0, 200.0, 180.0])
    assert norm_y["relative_rgb"] is not None
    assert norm_y["relative_rgb"][1] > 0, "Green channel should be positive relative to baseline"
    assert norm_y["relative_rgb"][2] < 0, "Blue channel should be negative relative to baseline"
    print("PASS")


def test_baseline_drift_check():
    """Test baseline environment drift detection."""
    print("[TEST] baseline_drift...", end=" ")

    baseline = Baseline()
    baseline.is_set = True
    baseline.rgb = [30.0, 50.0, 180.0]
    baseline.hsv = [110.0, 200.0, 180.0]
    baseline.frame_variance = 2.0

    # Same color — no drift
    result = baseline.check_drift([30.0, 50.0, 180.0], [110.0, 200.0, 180.0])
    assert not result["drifted"]

    # Very different color — drift detected
    result2 = baseline.check_drift([200.0, 30.0, 30.0], [10.0, 200.0, 200.0])
    assert result2["drifted"]
    print("PASS")


def test_baseline_save_load():
    """Test that baselines are saved and loaded correctly."""
    print("[TEST] baseline_save_load...", end=" ")
    import numpy as np

    with tempfile.TemporaryDirectory() as tmpdir:
        cal_file = os.path.join(tmpdir, "cal.json")
        mgr = CalibrationManager(cal_file)

        # Capture Sodium baseline
        frames = []
        for _ in range(5):
            frame = np.zeros((100, 100, 3), dtype=np.uint8)
            frame[10:90, 10:90] = (180, 50, 30)
            frames.append(frame)
        mgr.sodium.baseline.capture_from_frames(frames, (10, 10, 80, 80))
        assert mgr.sodium.baseline.is_set

        mgr.save()

        # Reload
        mgr2 = CalibrationManager(cal_file)
        assert mgr2.sodium.baseline.is_set
        assert mgr2.sodium.baseline.rgb is not None
        assert not mgr2.lactate.baseline.is_set

    print("PASS")


def main():
    print("=" * 60)
    print("DELTA COLORIMETRIC PIPELINE TEST")
    print("=" * 60)
    print()

    tests = [
        test_color_analysis,
        test_strip_detector,
        test_bcg_classifier,
        test_calibration,
        test_calibration_direction_validation,
        test_calibration_validation_metrics,
        test_baseline_capture,
        test_baseline_independent,
        test_baseline_required_for_measurement,
        test_baseline_relative_color,
        test_baseline_drift_check,
        test_baseline_save_load,
        test_sodium_lactate,
        test_blue_baseline_produces_low_values,
        test_interpolation_monotonic,
        test_outside_range,
        test_confidence,
        test_session,
        test_cross_validation,
    ]

    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"FAIL: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print()
    print("=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed out of {len(tests)}")
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
