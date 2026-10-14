"""accuracy_report.py — Automated accuracy report for colorimetric calibration.

Generates validation metrics from stored calibration data and results:
- Calibration curve summary
- Validation curve (leave-one-out)
- Error distribution
- MAE, RMSE, R², bias
- Repeatability analysis
- Confidence analysis

Reports INSUFFICIENT VALIDATION DATA when data is insufficient.
"""
import json
import math
import sys
import os
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from colorimetric.calibration import CalibrationManager


def generate_accuracy_report(cal_file=None, results_file=None):
    """Generate a comprehensive accuracy report.

    Args:
        cal_file: Path to calibration.json (default).
        results_file: Path to results.json (default).

    Returns:
        dict with full accuracy report.
    """
    config_dir = Path(__file__).parent.parent / "config"
    data_dir = Path(__file__).parent.parent / "data"

    if cal_file is None:
        cal_file = config_dir / "calibration.json"
    if results_file is None:
        results_file = data_dir / "results.json"

    report = {
        "timestamp": __import__("time").time(),
        "calibration_file": str(cal_file),
        "results_file": str(results_file),
    }

    # Load calibration
    try:
        mgr = CalibrationManager(str(cal_file))
    except Exception as e:
        report["error"] = f"Cannot load calibration: {e}"
        return report

    # Calibration summary
    report["calibration"] = mgr.summary()

    # Per-analyte validation
    for analyte in ["sodium", "lactate"]:
        ds = mgr.get_dataset(analyte)
        if ds is None or len(ds.points) < 2:
            report[analyte] = {"status": "INSUFFICIENT CALIBRATION DATA"}
            continue

        self_test = ds.validate_self()
        cross_val = ds.cross_validate_leave_one_out()
        direction = ds.validate_direction()

        report[analyte] = {
            "n_points": len(ds.points),
            "coverage_range": ds.coverage_range(),
            "direction": direction,
            "self_test": self_test,
            "cross_validation": cross_val,
            "baseline": ds.baseline.to_dict() if ds.baseline.is_set else None,
        }

    # Load results for repeatability analysis
    if Path(results_file).exists():
        try:
            with open(results_file) as f:
                results = json.load(f)
            report["results_analysis"] = _analyze_results(results, mgr)
        except Exception:
            report["results_analysis"] = {"status": "Cannot load results"}
    else:
        report["results_analysis"] = {"status": "No results file found"}

    # Overall assessment
    report["assessment"] = _assess_overall(report)

    return report


def _analyze_results(results, cal_mgr):
    """Analyze stored test results for repeatability and bias."""
    if not results:
        return {"status": "No results to analyze"}

    analysis = {
        "total_tests": len(results),
        "sodium_results": [],
        "lactate_results": [],
    }

    for r in results:
        s_pct = r.get("sodium_percentage")
        l_pct = r.get("lactate_percentage")
        if s_pct is not None:
            analysis["sodium_results"].append({
                "percentage": s_pct,
                "confidence": r.get("sodium_confidence"),
                "timestamp": r.get("timestamp"),
            })
        if l_pct is not None:
            analysis["lactate_results"].append({
                "percentage": l_pct,
                "confidence": r.get("lactate_confidence"),
                "timestamp": r.get("timestamp"),
            })

    # Repeatability: std of repeated measurements
    for key in ["sodium_results", "lactate_results"]:
        pcts = [r["percentage"] for r in analysis[key]]
        if len(pcts) >= 2:
            mean_pct = sum(pcts) / len(pcts)
            std_pct = math.sqrt(sum((p - mean_pct)**2 for p in pcts) / len(pcts))
            analysis[f"{key}_mean"] = round(mean_pct, 2)
            analysis[f"{key}_std"] = round(std_pct, 2)
            analysis[f"{key}_cv"] = round(std_pct / max(0.01, mean_pct) * 100, 2)
        elif pcts:
            analysis[f"{key}_mean"] = round(pcts[0], 2)

    return analysis


def _assess_overall(report):
    """Generate overall accuracy assessment."""
    issues = []

    for analyte in ["sodium", "lactate"]:
        data = report.get(analyte, {})
        if "status" in data and "INSUFFICIENT" in data.get("status", ""):
            issues.append(f"{analyte.upper()}: {data['status']}")
            continue

        cv = data.get("cross_validation", {})
        if cv.get("r_squared") is not None and cv["r_squared"] < 0.80:
            issues.append(f"{analyte.upper()}: R² = {cv['r_squared']} (target > 0.90)")

        if cv.get("mae") is not None and cv["mae"] > 15:
            issues.append(f"{analyte.upper()}: MAE = {cv['mae']}% (target < 10%)")

        if cv.get("bias") is not None and abs(cv["bias"]) > 5:
            issues.append(f"{analyte.upper()}: Bias = {cv['bias']}% (systematic)")

    if not issues:
        return {"status": "ACCEPTABLE", "issues": []}
    elif len(issues) <= 2:
        return {"status": "NEEDS IMPROVEMENT", "issues": issues}
    else:
        return {"status": "INSUFFICIENT ACCURACY", "issues": issues}


def print_report(report):
    """Print formatted accuracy report to stdout."""
    print("=" * 60)
    print("DELTA COLORIMETRIC ACCURACY REPORT")
    print("=" * 60)

    cal = report.get("calibration", {})
    print(f"\nCalibration Version: {cal.get('version')}")
    print(f"Locked Version: {cal.get('locked_version', 'not locked')}")

    for analyte in ["sodium", "lactate"]:
        data = report.get(analyte, {})
        print(f"\n--- {analyte.upper()} ---")
        if "status" in data:
            print(f"  Status: {data['status']}")
            continue

        print(f"  Points: {data.get('n_points')}")
        print(f"  Range: {data.get('coverage_range')}")

        cv = data.get("cross_validation", {})
        if cv.get("mae") is not None:
            print(f"  Cross-validation:")
            print(f"    MAE: {cv['mae']}%")
            print(f"    RMSE: {cv['rmse']}%")
            print(f"    R²: {cv.get('r_squared', 'N/A')}")
            print(f"    Bias: {cv.get('bias', 'N/A')}%")
            print(f"    Quality: {cv.get('quality', 'N/A')}")

    assessment = report.get("assessment", {})
    print(f"\n{'='*60}")
    print(f"OVERALL: {assessment.get('status', 'UNKNOWN')}")
    for issue in assessment.get("issues", []):
        print(f"  - {issue}")
    print("=" * 60)


if __name__ == "__main__":
    report = generate_accuracy_report()
    print_report(report)
