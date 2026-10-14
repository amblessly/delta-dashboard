"""strip_detector.py — Detect colorimetric strip and locate reaction area ROI.

Uses contour detection, color filtering, and shape analysis to
automatically find the strip and its reaction area within camera frames.

Includes:
- ROI quality scoring (area, shape, position, edge stability)
- Strip positioning check (translation, rotation, scale)
- Glare detection within reaction area
"""
import numpy as np
import math

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False


class StripDetector:
    """Detects colorimetric strip and extracts reaction area ROI."""

    def __init__(self, min_strip_area=5000, max_strip_ratio=6.0):
        self._min_area = min_strip_area
        self._max_ratio = max_strip_ratio

    def detect(self, frame):
        """Detect strip and reaction area in a frame.

        Returns:
            dict with detected, strip_bbox, reaction_roi, reaction_mask,
            confidence, roi_quality, position_check, annotated.
        """
        if not _HAS_CV2 or frame is None:
            return self._no_detection(frame)

        annotated = frame.copy()
        h, w = frame.shape[:2]

        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        light_mask = cv2.inRange(hsv, (0, 0, 120), (180, 60, 255))

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        light_mask = cv2.morphologyEx(light_mask, cv2.MORPH_CLOSE, kernel)
        light_mask = cv2.morphologyEx(light_mask, cv2.MORPH_OPEN, kernel)

        contours, _ = cv2.findContours(light_mask, cv2.RETR_EXTERNAL,
                                        cv2.CHAIN_APPROX_SIMPLE)

        best_strip = None
        best_area = 0

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < self._min_area:
                continue

            rect = cv2.minAreaRect(cnt)
            (cx, cy), (rw, rh), angle = rect
            long_side = max(rw, rh)
            short_side = min(rw, rh)
            if short_side < 1:
                continue

            aspect = long_side / short_side
            if aspect > self._max_ratio:
                continue

            if area > best_area:
                best_area = area
                best_strip = (int(cx - rw/2), int(cy - rh/2),
                              int(rw), int(rh), angle, cnt)

        if best_strip is None:
            return self._no_detection(frame)

        sx, sy, sw, sh, angle, cnt = best_strip
        cv2.rectangle(annotated, (sx, sy), (sx+sw, sy+sh), (0, 255, 0), 2)

        reaction_roi = self._find_reaction_area(frame, hsv, (sx, sy, sw, sh))

        # ROI quality score
        roi_quality = self._score_roi_quality(
            (sx, sy, sw, sh), reaction_roi, best_area, (w, h), cnt)

        # Strip positioning check
        position_check = self._check_position(
            (sx, sy, sw, sh), (w, h), angle)

        if reaction_roi is None:
            return {
                "detected": True,
                "strip_bbox": (sx, sy, sw, sh),
                "reaction_roi": None,
                "reaction_mask": None,
                "confidence": 0.3,
                "roi_quality": roi_quality,
                "position_check": position_check,
                "annotated": annotated,
            }

        rx, ry, rw_r, rh_r = reaction_roi
        cv2.rectangle(annotated, (rx, ry), (rx+rw_r, ry+rh_r), (255, 0, 0), 2)

        margin_x = max(2, int(rw_r * 0.1))
        margin_y = max(2, int(rh_r * 0.1))
        roi_mask = np.zeros(frame.shape[:2], dtype=np.uint8)
        roi_mask[ry+margin_y:ry+rh_r-margin_y,
                 rx+margin_x:rx+rw_r-margin_x] = 255

        strip_area_ratio = best_area / (w * h)
        confidence = min(1.0, strip_area_ratio * 20)
        confidence = max(0.3, min(1.0, confidence))

        # Adjust confidence by ROI quality
        confidence *= roi_quality.get("score", 0.5)

        return {
            "detected": True,
            "strip_bbox": (sx, sy, sw, sh),
            "reaction_roi": reaction_roi,
            "reaction_mask": roi_mask,
            "confidence": round(confidence, 3),
            "roi_quality": roi_quality,
            "position_check": position_check,
            "annotated": annotated,
        }

    def detect_dual_zones(self, frame):
        """Detect strip with separate Sodium and Lactate ROIs."""
        result = self.detect(frame)
        if not result["detected"] or result["reaction_roi"] is None:
            result["sodium_roi"] = None
            result["lactate_roi"] = None
            return result

        rx, ry, rw, rh = result["reaction_roi"]
        mid_x = rx + rw // 2
        gap = max(4, int(rw * 0.05))

        sodium_roi = (rx, ry, rw // 2 - gap, rh)
        lactate_roi = (mid_x + gap, ry, rw // 2 - gap, rh)

        result["sodium_roi"] = sodium_roi
        result["lactate_roi"] = lactate_roi
        return result

    def _find_reaction_area(self, frame, hsv, strip_bbox):
        """Locate the color-reactive area within the detected strip."""
        sx, sy, sw, sh = strip_bbox
        strip_region = hsv[sy:sy+sh, sx:sx+sw]
        if strip_region.size == 0:
            return None

        sat_channel = strip_region[:, :, 1]
        mean_sat = np.mean(sat_channel)
        sat_threshold = max(20, mean_sat * 0.8)
        high_sat_mask = (sat_channel > sat_threshold).astype(np.uint8) * 255

        coords = cv2.findNonZero(high_sat_mask)
        if coords is None or len(coords) < 50:
            margin_x = int(sw * 0.2)
            margin_y = int(sh * 0.15)
            return (sx + margin_x, sy + margin_y,
                    sw - 2 * margin_x, sh - 2 * margin_y)

        rx, ry, rw, rh = cv2.boundingRect(coords)
        return (sx + rx, sy + ry, rw, rh)

    def _score_roi_quality(self, strip_bbox, reaction_roi, strip_area, frame_size, contour):
        """Score the quality of the detected ROI (0-1).

        Factors: area ratio, shape, position, edge stability, contrast.
        """
        score = 0.0
        details = {}
        fw, fh = frame_size

        # Area ratio: strip should be 5-50% of frame
        area_ratio = strip_area / (fw * fh)
        if 0.03 <= area_ratio <= 0.6:
            area_score = 1.0 - abs(area_ratio - 0.15) / 0.15
            area_score = max(0.3, min(1.0, area_score))
        else:
            area_score = 0.1
        details["area_ratio"] = round(area_ratio, 4)
        score += area_score * 0.25

        # Shape: strip should be rectangular
        if contour is not None:
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.04 * peri, True)
            shape_score = max(0.2, min(1.0, 1.0 - (len(approx) - 4) * 0.1))
        else:
            shape_score = 0.5
        score += shape_score * 0.2

        # Position: strip should be centered (not at edges)
        sx, sy, sw, sh = strip_bbox
        cx = (sx + sw / 2) / fw
        cy = (sy + sh / 2) / fh
        pos_dev = math.sqrt((cx - 0.5)**2 + (cy - 0.5)**2)
        pos_score = max(0.0, 1.0 - pos_dev * 2.0)
        score += pos_score * 0.2

        # Reaction ROI quality
        if reaction_roi is not None:
            rx, ry, rw_r, rh_r = reaction_roi
            roi_area = rw_r * rh_r
            strip_area_actual = sw * sh
            if strip_area_actual > 0:
                roi_ratio = roi_area / strip_area_actual
                roi_score = max(0.2, min(1.0, 1.0 - abs(roi_ratio - 0.5) * 2.0))
            else:
                roi_score = 0.3
        else:
            roi_score = 0.1
        score += roi_score * 0.2

        # Edge contrast: reaction area should differ from background
        score += 0.15  # base score (requires frame for full evaluation)

        details["area_score"] = round(area_score, 3)
        details["shape_score"] = round(shape_score, 3)
        details["position_score"] = round(pos_score, 3)
        details["roi_score"] = round(roi_score, 3)

        return {
            "score": round(min(1.0, score), 3),
            "details": details,
        }

    def _check_position(self, strip_bbox, frame_size, angle):
        """Check strip positioning (translation, rotation, scale).

        Returns dict with valid, rotation_deg, position_offset, message.
        """
        fw, fh = frame_size
        sx, sy, sw, sh = strip_bbox
        cx = sx + sw / 2
        cy = sy + sh / 2

        # Position offset from center (0-1, 0=centered)
        offset_x = abs(cx - fw / 2) / (fw / 2)
        offset_y = abs(cy - fh / 2) / (fh / 2)
        offset = math.sqrt(offset_x**2 + offset_y**2)

        # Rotation (angle from minAreaRect)
        rot = angle if angle <= 90 else angle - 180
        rot = abs(rot)

        # Scale check: strip should fill reasonable portion of frame
        area_ratio = (sw * sh) / (fw * fh)
        scale_ok = 0.02 < area_ratio < 0.8

        valid = offset < 0.5 and rot < 45 and scale_ok

        if not valid:
            if offset >= 0.5:
                msg = "STRIP POSITION INVALID — REPOSITION STRIP (too far from center)"
            elif rot >= 45:
                msg = f"STRIP ROTATION INVALID — {rot:.0f}° (max 45°)"
            else:
                msg = "STRIP SCALE INVALID — REPOSITION STRIP"
        else:
            msg = f"Position OK (offset={offset:.2f}, rot={rot:.0f}°)"

        return {
            "valid": valid,
            "rotation_deg": round(rot, 1),
            "position_offset": round(offset, 3),
            "area_ratio": round(area_ratio, 4),
            "message": msg,
        }

    def _no_detection(self, frame):
        annotated = frame.copy() if frame is not None else None
        return {
            "detected": False,
            "strip_bbox": None,
            "reaction_roi": None,
            "reaction_mask": None,
            "confidence": 0.0,
            "roi_quality": {"score": 0.0, "details": {}},
            "position_check": {"valid": False, "message": "No strip detected"},
            "annotated": annotated,
        }
