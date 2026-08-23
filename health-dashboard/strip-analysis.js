/* --------------------
   strip-analysis.js - Colorimetric strip image processing layer.

   Pure functions, no DOM access. Implements the methodology described
   in the source document (BCG strip + camera + RGB image analysis):

     capture -> ROI extraction -> RGB statistics -> quality gate
       -> calibrated color matching  OR  uncalibrated hue estimate

   IMPORTANT (per project rules):
   - No RGB calibration values are fabricated here. Calibrated matching
     only runs against points entered by the operator (see calibration.js).
   - The hue-based fallback encodes ONLY the documented BCG response order
     (yellow below pH ~3.8, green in the 3.8-5.4 band, blue above ~5.4).
     Its numeric thresholds are engineering heuristics for a rough zone
     estimate, clearly labelled UNCALIBRATED ESTIMATE in the UI, and its
     confidence is capped so it can never look like a lab measurement.
   -------------------- */

"use strict";

window.StripAnalysis = (function () {

  /* Default region of interest, normalised to frame (0-1) so it scales
     with any camera resolution. Calibrated on-site by the operator. */
  const DEFAULT_ROI = { x: 0.34, y: 0.30, w: 0.32, h: 0.40 };

  const MIN_ROI_SIZE = 0.05;          /* fraction of frame */
  const MIN_PIXELS = 16 * 16;         /* need a real area, not noise */
  const TOO_DARK_BRIGHTNESS = 45;     /* avg luminance 0-255 */
  const TOO_BRIGHT_BRIGHTNESS = 215;
  const WASHED_OUT_SATURATION = 8;    /* % saturation below = no usable color */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function normalizeROI(roi) {
    const r = roi || {};
    const x = clamp(Number(r.x) || 0, 0, 1);
    const y = clamp(Number(r.y) || 0, 0, 1);
    const w = clamp(Number(r.w) || DEFAULT_ROI.w, MIN_ROI_SIZE, 1 - x);
    const h = clamp(Number(r.h) || DEFAULT_ROI.h, MIN_ROI_SIZE, 1 - y);
    return { x, y, w, h };
  }

  /* Extract an ImageData for the ROI from a canvas 2D context. */
  function extractROI(ctx, roi, frameW, frameH) {
    const r = normalizeROI(roi);
    const sx = Math.round(r.x * frameW);
    const sy = Math.round(r.y * frameH);
    const sw = Math.max(1, Math.round(r.w * frameW));
    const sh = Math.max(1, Math.round(r.h * frameH));
    if (sw * sh < MIN_PIXELS / 4) return null;
    try {
      return ctx.getImageData(sx, sy, sw, sh);
    } catch (e) {
      return null;
    }
  }

  function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return {
      h: Math.round(h),
      s: max === 0 ? 0 : Math.round((d / max) * 100),
      v: Math.round(max * 100),
    };
  }

  /* Average color + usability statistics over an ImageData. */
  function analyzePixels(imageData) {
    if (!imageData) return null;
    const d = imageData.data;
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++;
    }
    if (n === 0) return null;
    const r = Math.round(rs / n), g = Math.round(gs / n), b = Math.round(bs / n);
    const brightness = Math.round((r * 0.299 + g * 0.587 + b * 0.114));
    const hsv = rgbToHsv(r, g, b);
    return {
      r, g, b, count: n,
      brightness,
      saturation: hsv.s,
      hsv,
    };
  }

  /* Quality gate before any pH interpretation is attempted.
     Returns { ok, issues:[{code,message}] }. */
  function assessQuality(stats) {
    const issues = [];
    if (!stats || stats.count < MIN_PIXELS) {
      issues.push({ code: "TOO_FEW_PIXELS", message: "Strip area too small or not visible." });
    }
    if (stats && stats.brightness < TOO_DARK_BRIGHTNESS) {
      issues.push({ code: "TOO_DARK", message: "Image too dark - check controlled lighting." });
    }
    if (stats && stats.brightness > TOO_BRIGHT_BRIGHTNESS) {
      issues.push({ code: "TOO_BRIGHT", message: "Image too bright / overexposed." });
    }
    if (stats && stats.saturation < WASHED_OUT_SATURATION) {
      issues.push({ code: "WASHED_OUT", message: "No readable color - strip missing or washed out." });
    }
    return { ok: issues.length === 0, issues };
  }

  function euclidean(a, b) {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /* Nearest-reference matching against operator-entered calibration
     points [{ph, r, g, b}]. Returns best match + heuristic confidence.
     Confidence mapping: dist 0 -> 100%, dist 120 -> 40%, >=160 -> <20%.
     This is a similarity score for UI guidance, not a scientific measure. */
  function matchCalibrated(rgb, points) {
    if (!points || points.length === 0 || !rgb) return null;
    let best = null;
    for (const p of points) {
      const dist = euclidean(rgb, p);
      if (!best || dist < best.dist) {
        best = { point: p, dist };
      }
    }
    const confidence = Math.max(0, Math.min(100, Math.round(100 - best.dist / 2)));
    return { ...best, confidence };
  }

  /* Hue-band boundaries follow the DOCUMENTED BCG transition order only:
     yellow -> yellow-green -> green -> blue as pH rises. The numbers are
     coarse heuristics for an uncalibrated estimate and are surfaced as
     such by the caller (confidence capped, method label shown). */
  const HUE_BANDS = [
    { maxHue: 65,        zoneId: "brightyellow" },
    { maxHue: 95,        zoneId: "yellowgreen" },
    { maxHue: 155,       zoneId: "greenzone" },
    { maxHue: 361,       zoneId: "blue" },
  ];

  function estimateZoneFromHue(hsv) {
    if (!hsv) return null;
    const band = HUE_BANDS.find(b => hsv.h <= b.maxHue) || HUE_BANDS[HUE_BANDS.length - 1];
    return band.zoneId;
  }

  /* Uncalibrated estimates never exceed this confidence so they cannot be
     mistaken for a validated measurement. */
  const UNCALIBRATED_MAX_CONFIDENCE = 55;

  function confidenceUncalibrated(hsv) {
    /* Slightly higher confidence for saturated, mid-brightness colors. */
    const satScore = Math.min(1, hsv.s / 60);
    const valOk = hsv.v > 25 && hsv.v < 90 ? 1 : 0.6;
    return Math.max(10, Math.min(
      UNCALIBRATED_MAX_CONFIDENCE,
      Math.round((30 + 25 * satScore) * valOk)
    ));
  }

  return {
    DEFAULT_ROI,
    normalizeROI,
    extractROI,
    analyzePixels,
    assessQuality,
    rgbToHsv,
    euclidean,
    matchCalibrated,
    estimateZoneFromHue,
    confidenceUncalibrated,
    UNCALIBRATED_MAX_CONFIDENCE,
  };
})();
