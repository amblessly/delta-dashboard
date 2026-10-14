"""color_analysis.py — RGB, HSV, Lab extraction from reaction area ROI.

Provides robust color measurement using:
- Center ROI (inner 70%) to exclude edge artifacts
- Pixel-level rejection (glare, dark, dead, saturation clipping)
- Robust statistics (median, MAD-filtered mean, trimmed mean)
- CIE Lab color space for perceptual accuracy
- Frame-level outlier rejection (MAD-based)
- Glare fraction, lighting consistency, and quality metrics
"""
import json
import numpy as np
from pathlib import Path

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False


_DEFAULT_CONFIG_DIR = Path(__file__).parent / "config"
_DEFAULT_CAM_CONFIG = _DEFAULT_CONFIG_DIR / "camera_config.json"


def _load_cfg():
    path = _DEFAULT_CAM_CONFIG
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def bgr_to_lab(bgr_pixels):
    """Convert BGR pixel array to CIE Lab."""
    if not _HAS_CV2 or bgr_pixels is None or len(bgr_pixels) == 0:
        return None
    arr = np.array(bgr_pixels, dtype=np.uint8).reshape(-1, 1, 3)
    lab = cv2.cvtColor(arr, cv2.COLOR_BGR2Lab).reshape(-1, 3).astype(float)
    return lab


def extract_roi_color(frame, roi, mask=None):
    """Extract robust color statistics from a region of interest.

    Uses median and MAD-filtered mean for robustness against outliers.
    Returns RGB, HSV, Lab, and quality metrics.

    Args:
        frame: BGR numpy array.
        roi: (x, y, w, h) bounding box.
        mask: Optional binary mask for the ROI.

    Returns:
        dict with rgb, hsv, lab, quality metrics, or None.
    """
    if not _HAS_CV2 or frame is None or roi is None:
        return None

    cfg = _load_cfg()
    x, y, w, h = roi
    h_frame, w_frame = frame.shape[:2]

    x = max(0, min(x, w_frame - 1))
    y = max(0, min(y, h_frame - 1))
    w = min(w, w_frame - x)
    h = min(h, h_frame - y)
    if w < 5 or h < 5:
        return None

    roi_region = frame[y:y+h, x:x+w]
    if roi_region.size == 0:
        return None

    # Inner ROI: center 70% to exclude strip edges and artifacts
    inner_margin = cfg.get("roi_inner_margin", 0.15)
    mx = max(1, int(w * inner_margin))
    my = max(1, int(h * inner_margin))
    inner_mask = np.zeros((h, w), dtype=np.uint8)
    inner_mask[my:h-my, mx:w-mx] = 255

    if mask is not None:
        mask_crop = mask[y:y+h, x:x+w]
        if mask_crop.shape == inner_mask.shape:
            inner_mask = cv2.bitwise_and(inner_mask, mask_crop)

    # Convert to HSV for filtering
    roi_hsv = cv2.cvtColor(roi_region, cv2.COLOR_BGR2HSV)
    v_ch = roi_hsv[:, :, 2]
    s_ch = roi_hsv[:, :, 1]

    # Pixel-level rejection
    glare_thresh_v = cfg.get("glare_threshold_v", 240)
    glare_thresh_s = cfg.get("glare_threshold_s", 30)
    dark_thresh_v = cfg.get("dark_threshold_v", 20)

    glare_mask = (v_ch > glare_thresh_v) & (s_ch < glare_thresh_s)
    dark_mask = v_ch < dark_thresh_v
    dead_mask = (s_ch == 0) & (v_ch == 0)
    saturation_clip = (v_ch >= 255) & (s_ch > 200)

    reject_mask = glare_mask | dark_mask | dead_mask | saturation_clip
    inner_mask[reject_mask] = 0

    total_inner = int(np.count_nonzero(np.zeros((h, w), dtype=np.uint8) + 255))
    glare_count = int(np.count_nonzero(glare_mask & (inner_mask | reject_mask)))
    dark_count = int(np.count_nonzero(dark_mask))

    valid_pixels = int(np.count_nonzero(inner_mask))
    total_pixels = w * h

    min_valid = cfg.get("min_valid_pixels", 50)
    if valid_pixels < min_valid:
        return None

    # Extract valid pixels
    valid_bgr = roi_region[inner_mask > 0]
    valid_rgb = valid_bgr[:, ::-1].astype(float)
    valid_hsv = roi_hsv[inner_mask > 0].astype(float)
    valid_lab = bgr_to_lab(valid_bgr)

    # Robust statistics: median + MAD-filtered mean
    # Median is inherently robust
    med_rgb = np.median(valid_rgb, axis=0)
    med_hsv = np.median(valid_hsv, axis=0)

    # MAD-filtered mean: reject pixels > 3 MAD from median
    mad_rgb = np.median(np.abs(valid_rgb - med_rgb), axis=0)
    mad_rgb[mad_rgb < 1.0] = 1.0
    deviations = np.abs(valid_rgb - med_rgb) / (mad_rgb * 1.4826)
    mad_keep = np.all(deviations < cfg.get("outlier_mad_threshold", 3.0), axis=1)
    if np.sum(mad_keep) > 10:
        filtered_rgb = valid_rgb[mad_keep]
        filtered_hsv = valid_hsv[mad_keep]
    else:
        filtered_rgb = valid_rgb
        filtered_hsv = valid_hsv

    # Trimmed mean (remove top/bottom 10% per channel)
    trimmed_pct = cfg.get("trimmed_mean_pct", 0.1)
    def _trimmed_mean(arr, pct):
        lo = int(len(arr) * pct)
        hi = len(arr) - lo
        if hi <= lo:
            return np.mean(arr, axis=0)
        sorted_arr = np.sort(arr, axis=0)
        return np.mean(sorted_arr[lo:hi], axis=0)

    avg_rgb = _trimmed_mean(filtered_rgb, trimmed_pct)
    avg_hsv = _trimmed_mean(filtered_hsv, trimmed_pct)

    # Std from filtered set
    std_rgb = np.std(filtered_rgb, axis=0) if len(filtered_rgb) > 1 else np.zeros(3)
    std_hsv = np.std(filtered_hsv, axis=0) if len(filtered_hsv) > 1 else np.zeros(3)

    # Lab color
    avg_lab = [0.0, 0.0, 0.0]
    if valid_lab is not None and len(valid_lab) > 10:
        lab_mad = np.median(np.abs(valid_lab - np.median(valid_lab, axis=0)), axis=0)
        lab_mad[lab_mad < 0.5] = 0.5
        lab_devs = np.abs(valid_lab - np.median(valid_lab, axis=0)) / (lab_mad * 1.4826)
        lab_keep = np.all(lab_devs < cfg.get("outlier_mad_threshold", 3.0), axis=1)
        if np.sum(lab_keep) > 10:
            avg_lab = np.median(valid_lab[lab_keep], axis=0).tolist()
        else:
            avg_lab = np.median(valid_lab, axis=0).tolist()

    # Glare fraction
    inner_total = max(1, int(np.count_nonzero(np.zeros((h, w), dtype=np.uint8) + 255) * (1 - 2*inner_margin)**2))
    glare_fraction = glare_count / max(1, valid_pixels + glare_count)

    # Coverage
    coverage = valid_pixels / max(1, total_pixels)

    # Color uniformity (inverse of mean std, 0-1)
    avg_std = float(np.mean(std_rgb))
    uniformity = max(0.0, 1.0 - avg_std / 80.0)

    return {
        "rgb": [float(avg_rgb[0]), float(avg_rgb[1]), float(avg_rgb[2])],
        "hsv": [float(avg_hsv[0]), float(avg_hsv[1]), float(avg_hsv[2])],
        "lab": [float(v) for v in avg_lab],
        "rgb_std": [float(std_rgb[0]), float(std_rgb[1]), float(std_rgb[2])],
        "hsv_std": [float(std_hsv[0]), float(std_hsv[1]), float(std_hsv[2])],
        "rgb_median": [float(med_rgb[0]), float(med_rgb[1]), float(med_rgb[2])],
        "hsv_median": [float(med_hsv[0]), float(med_hsv[1]), float(med_hsv[2])],
        "valid_pixels": valid_pixels,
        "total_pixels": total_pixels,
        "coverage": coverage,
        "glare_fraction": round(float(glare_fraction), 4),
        "dark_fraction": round(float(dark_count / max(1, total_pixels)), 4),
        "color_uniformity": round(float(uniformity), 3),
    }


def analyze_multi_frame(frames, roi, mask=None):
    """Analyze multiple frames with robust outlier rejection.

    Uses MAD-based frame rejection and returns filtered statistics.

    Args:
        frames: List of BGR numpy arrays.
        roi: (x, y, w, h) reaction area.
        mask: Optional analysis mask.

    Returns:
        dict with averaged/filtered rgb, hsv, lab, consistency, quality metrics.
    """
    if not frames or roi is None:
        return None

    cfg = _load_cfg()

    results = []
    for frame in frames:
        r = extract_roi_color(frame, roi, mask)
        if r is not None and r["valid_pixels"] >= cfg.get("min_valid_pixels", 50):
            results.append(r)

    if not results:
        return None

    if len(results) == 1:
        r = results[0]
        r["frame_count"] = 1
        r["consistency"] = 1.0
        r["lighting_score"] = 1.0
        r["glare_score"] = 1.0
        return r

    # MAD-based frame outlier rejection
    all_rgb = np.array([r["rgb"] for r in results])
    med_frame_rgb = np.median(all_rgb, axis=0)
    mad_frame = np.median(np.abs(all_rgb - med_frame_rgb), axis=0)
    mad_frame[mad_frame < 1.0] = 1.0
    frame_devs = np.abs(all_rgb - med_frame_rgb) / (mad_frame * 1.4826)
    frame_max_dev = np.max(frame_devs, axis=1)

    mad_thresh = cfg.get("outlier_mad_threshold", 3.0)
    kept = [results[i] for i in range(len(results)) if frame_max_dev[i] < mad_thresh]

    if len(kept) < 2:
        kept = results  # fallback

    # Aggregate with trimmed mean across frames
    all_kept_rgb = np.array([r["rgb"] for r in kept])
    all_kept_hsv = np.array([r["hsv"] for r in kept])

    trimmed_pct = cfg.get("trimmed_mean_pct", 0.1)
    def _trimmed_mean(arr, pct):
        if len(arr) <= 2:
            return np.mean(arr, axis=0)
        lo = int(len(arr) * pct)
        hi = len(arr) - lo
        if hi <= lo:
            return np.mean(arr, axis=0)
        sorted_arr = np.sort(arr, axis=0)
        return np.mean(sorted_arr[lo:hi], axis=0)

    avg_rgb = _trimmed_mean(all_kept_rgb, trimmed_pct).tolist()
    avg_hsv = _trimmed_mean(all_kept_hsv, trimmed_pct).tolist()

    # Lab across frames
    avg_lab = [0.0, 0.0, 0.0]
    if kept[0].get("lab") and any(v != 0 for v in kept[0]["lab"]):
        all_lab = np.array([r["lab"] for r in kept])
        avg_lab = _trimmed_mean(all_lab, trimmed_pct).tolist()

    # Std across kept frames (frame-to-frame consistency)
    frame_std_rgb = np.std(all_kept_rgb, axis=0)
    avg_frame_std = float(np.mean(frame_std_rgb))
    consistency = max(0.0, 1.0 - avg_frame_std / cfg.get("frame_consistency_limit", 25.0))

    # Lighting consistency: compare brightness across frames
    all_v = np.array([r["hsv"][2] for r in kept])
    v_range = float(np.max(all_v) - np.min(all_v))
    lighting_score = max(0.0, 1.0 - v_range / cfg.get("lighting_change_threshold", 15.0))

    # Glare score
    glare_fracs = [r["glare_fraction"] for r in kept]
    avg_glare = np.mean(glare_fracs)
    glare_score = max(0.0, 1.0 - avg_glare / cfg.get("glare_max_fraction", 0.05))

    # Aggregate stds
    avg_rgb_std = np.mean([r["rgb_std"] for r in kept], axis=0).tolist()
    avg_hsv_std = np.mean([r["hsv_std"] for r in kept], axis=0).tolist()
    avg_coverage = np.mean([r["coverage"] for r in kept])
    avg_uniformity = np.mean([r["color_uniformity"] for r in kept])

    return {
        "rgb": avg_rgb,
        "hsv": avg_hsv,
        "lab": avg_lab,
        "rgb_std": avg_rgb_std,
        "hsv_std": avg_hsv_std,
        "rgb_median": [float(np.median(all_kept_rgb[:, i])) for i in range(3)],
        "hsv_median": [float(np.median(all_kept_hsv[:, i])) for i in range(3)],
        "valid_pixels": sum(r["valid_pixels"] for r in kept) // len(kept),
        "total_pixels": kept[0]["total_pixels"],
        "coverage": avg_coverage,
        "frame_count": len(kept),
        "frames_rejected": len(results) - len(kept),
        "consistency": round(float(consistency), 3),
        "lighting_score": round(float(lighting_score), 3),
        "glare_score": round(float(glare_score), 3),
        "glare_fraction": round(float(avg_glare), 4),
        "color_uniformity": round(float(avg_uniformity), 3),
        "frame_rgb_std": round(float(avg_frame_std), 2),
    }


def color_distance_rgb(c1, c2):
    """Euclidean distance in RGB space."""
    a = np.array(c1[:3], dtype=float)
    b = np.array(c2[:3], dtype=float)
    return float(np.linalg.norm(a - b))


def color_distance_lab(c1, c2):
    """Perceptual color distance in CIE Lab space (Delta-E 1976).

    Requires OpenCV. Falls back to RGB distance if unavailable.
    """
    if not _HAS_CV2:
        return color_distance_rgb(c1, c2)

    try:
        a1 = np.uint8([[c1[:3]]])
        a2 = np.uint8([[c2[:3]]])
        lab1 = cv2.cvtColor(a1, cv2.COLOR_BGR2Lab).astype(float)[0, 0]
        lab2 = cv2.cvtColor(a2, cv2.COLOR_BGR2Lab).astype(float)[0, 0]
        return float(np.linalg.norm(lab1 - lab2))
    except Exception:
        return color_distance_rgb(c1, c2)


def color_distance_lab_direct(lab1, lab2):
    """Direct Lab Delta-E when Lab values are already available."""
    a = np.array(lab1[:3], dtype=float)
    b = np.array(lab2[:3], dtype=float)
    return float(np.linalg.norm(a - b))


def color_distance_combined(c1_rgb, c2_rgb, c1_hsv=None, c2_hsv=None,
                            c1_lab=None, c2_lab=None, weights=None):
    """Combined RGB + Lab + HSV distance.

    Default weights: 40% Lab + 30% RGB + 30% HSV.
    Configurable via weights dict.
    """
    if weights is None:
        weights = {"lab": 0.40, "rgb": 0.30, "hsv": 0.30}

    rgb_d = color_distance_rgb(c1_rgb, c2_rgb)

    # Lab distance: use direct if Lab values provided, else convert from BGR
    if c1_lab is not None and c2_lab is not None:
        lab_d = color_distance_lab_direct(c1_lab, c2_lab)
    else:
        lab_d = color_distance_lab(c1_rgb, c2_rgb)

    hsv_d = 0.0
    if c1_hsv is not None and c2_hsv is not None:
        h1, s1, v1 = c1_hsv[:3]
        h2, s2, v2 = c2_hsv[:3]
        dh = min(abs(h1 - h2), 180 - abs(h1 - h2)) / 180.0
        ds = abs(s1 - s2) / 255.0
        dv = abs(v1 - v2) / 255.0
        hsv_d = (dh * 0.5 + ds * 0.3 + dv * 0.2) * 200

    return (weights["lab"] * lab_d +
            weights["rgb"] * rgb_d +
            weights["hsv"] * hsv_d)
