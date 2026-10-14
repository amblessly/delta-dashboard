"use strict";

/* thermal-panel.js — MLX90640 thermal heatmap + temperature display.

   Polls the Python thermal reader at http://<host>:8001/thermal
   every 2 seconds and renders a 32x24 color-mapped heatmap
   onto a <canvas> element.  Also updates the temperature card's
   value with the live MLX90640 skin temperature, and displays
   the temperature-based stress contribution and confidence
   from the Python stress_estimator module.

   The temperature contribution is a HEURISTIC indicator —
   MLX90640 measures surface (skin) temperature, not core body
   temperature.  Results are labeled "Estimated stress indicator",
   NOT as a medical diagnosis. */

window.ThermalPanel = (function () {

  const POLL_MS = 2000;
  const THERMAL_URL = "http://" + (location.hostname || "localhost") + ":8001/thermal";
  const COLS = 32;
  const ROWS = 24;

  let timer = null;
  let canvas = null;
  let ctx = null;
  let tempValueEl = null;
  let lastStressData = null;

  /* Callback so main.js can receive stress updates */
  let onStressUpdate = null;

  /* ── Color mapping: temperature → CSS color ──
     Uses dynamic range (frame min/max) for visual clarity,
     with absolute calibration labels for stress assessment.
     Color stops represent relative position in the observed range.
  ── */
  const ABS_LO = 20;
  const ABS_HI = 55;

  function tempColor(t, lo, hi) {
    if (t == null || isNaN(t)) return [0, 0, 0, 0];
    /* Clamp to absolute bounds so stray readings don't break color */
    const clamped = Math.max(ABS_LO, Math.min(ABS_HI, t));
    /* Use frame min/max for dynamic visualization range */
    const rangeLo = Math.max(ABS_LO, Math.min(lo, 25));
    const rangeHi = Math.min(ABS_HI, Math.max(hi, 45));
    const ratio = Math.max(0, Math.min(1, (clamped - rangeLo) / (rangeHi - rangeLo || 1)));
    /* Color stops:
       0.00 = coolest in frame → dark blue
       0.25 = cool → blue
       0.40 = moderate cool → cyan
       0.55 = mid → green
       0.70 = warm → yellow
       0.80 = hot → orange
       0.90 = very hot → red
       1.00 = hottest → deep red */
    const stops = [
      [0.00,  15,  15,  50],
      [0.25,  30,  80, 200],
      [0.40,   0, 160, 210],
      [0.55,  30, 190,  80],
      [0.70, 210, 200,  30],
      [0.80, 240, 150,  15],
      [0.90, 220,  50,  15],
      [1.00, 180,  10,  10],
    ];
    let i = 0;
    for (; i < stops.length - 1; i++) {
      if (ratio <= stops[i + 1][0]) break;
    }
    const a = stops[i], b = stops[i + 1];
    const f = (ratio - a[0]) / (b[0] - a[0] || 1);
    return [
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
      Math.round(a[3] + (b[3] - a[3]) * f),
      220,
    ];
  }

  /* ── Draw heatmap + update temp card ── */
  function render(grid, meta, stress) {
    if (!canvas || !ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const cellW = cw / COLS;
    const cellH = ch / ROWS;

    ctx.clearRect(0, 0, cw, ch);

    const lo = meta.min_frame != null ? meta.min_frame : 25;
    const hi = meta.max_frame != null ? meta.max_frame : 45;

    for (let r = 0; r < ROWS; r++) {
      const row = grid[r];
      if (!row) continue;
      for (let c = 0; c < COLS; c++) {
        const [red, green, blue, alpha] = tempColor(row[c], lo, hi);
        ctx.fillStyle = `rgba(${red},${green},${blue},${alpha / 255})`;
        ctx.fillRect(c * cellW, r * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    /* Update the temperature card value with live MLX90640 skin temp */
    if (tempValueEl && meta.max_skin != null) {
      if (meta.heatSource) {
        tempValueEl.textContent = "N/A";
        const detEl = document.getElementById("tempDetail");
        if (detEl) {
          detEl.textContent = "Sensor near heat source — reposition MLX90640";
          detEl.className = "temp-detail mono elevated";
        }
      } else {
        tempValueEl.textContent = Number(meta.max_skin).toFixed(1);
      }
    }

    /* Update temperature contribution detail on temp card */
    if (stress) {
      lastStressData = stress;
      const detEl = document.getElementById("tempDetail");
      const confEl = document.getElementById("tempConfidence");
      if (detEl) {
        if (!stress.calibrated) {
          detEl.textContent = "Calibrating baseline\u2026";
          detEl.className = "temp-detail mono calibrating";
        } else {
          let deltaText = "";
          if (stress.signedDelta != null) {
            const sign = stress.signedDelta >= 0 ? "+" : "";
            deltaText = `${sign}${Number(stress.signedDelta).toFixed(2)}\u00B0C from baseline`;
          }
          detEl.textContent = stress.label + (deltaText ? ` \u00B7 ${deltaText}` : "");
          detEl.className = "temp-detail mono " + (stress.contribution >= 55 ? "elevated" : "");
        }
      }
      if (confEl) {
        confEl.textContent = `Confidence: ${stress.confidence}%`;
      }

      /* Notify main.js of stress update */
      if (onStressUpdate) onStressUpdate(stress);
    }
  }

  /* ── Poll loop ── */
  async function poll() {
    try {
      const resp = await fetch(THERMAL_URL, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.grid && data.meta) render(data.grid, data.meta, data.stress || null);
    } catch (e) {
      /* sensor not available — silent fail */
    }
  }

  /* ── Public API ── */
  function start(canvasEl, stressCallback) {
    canvas = canvasEl;
    tempValueEl = document.getElementById("tempValue");
    onStressUpdate = typeof stressCallback === "function" ? stressCallback : null;
    if (canvas) {
      canvas.width = COLS * 10;
      canvas.height = ROWS * 10;
      ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
    }
    if (timer) clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
    poll();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    lastStressData = null;
    onStressUpdate = null;
  }

  function getLastStressData() { return lastStressData; }

  return { start, stop, getLastStressData };
})();
