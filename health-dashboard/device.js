/* --------------------
   device.js - Camera, controlled lighting, and measurement pipeline.

   Manages the physical-device concept described in the source document:

     Controlled Lighting -> Colorimetric Strip -> Camera -> Image
       -> ROI Extraction -> RGB Analysis -> Color Matching -> pH Result

   When real hardware is absent, runs in SIMULATION mode using a
   synthetic dark-frame render that demonstrates the full pipeline
   (including quality-gate error paths when lighting is OFF).
   -------------------- */

"use strict";

window.StripDevice = (function () {

  const MAX_ANALYSIS_W = 480;
  const PREVIEW_INTERVAL = 120;
  const SYNTH_PALETTE = {
    brightyellow: "#fbbf24",
    yellowgreen:  "#a3e635",
    greenzone:    "#34d399",
    blue:         "#60a5fa",
  };

  function createManager(opts) {
    const {
      viewCanvas,
      videoEl,
      getSimulatedPH,
      onStatus,
      onProcessing,
      onResult,
    } = opts;

    /* ── State ─────────────────────────────────────────────────────── */
    const state = {
      mode: "SIMULATION",
      camera: "UNAVAILABLE",
      lighting: "ON",
      strip: "AWAITING CAPTURE",
      sensors: "SIMULATION",
      processing: "READY",
      lastError: null,
    };

    const workCanvas = document.createElement("canvas");
    const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
    let stream = null;
    let previewTimer = null;
    let lastCapture = null;
    const R = StripAnalysis.normalizeROI(StripAnalysis.DEFAULT_ROI);

    function setState(patch) {
      Object.assign(state, patch);
      if (onStatus) onStatus({ ...state });
    }

    /* ── Camera start / stop ───────────────────────────────────────── */

    async function start() {
      if (stream) stop();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
          });
          if (videoEl) {
            videoEl.srcObject = stream;
            await videoEl.play().catch(() => {});
          }
          setState({ mode: "LIVE_CAMERA", camera: "CONNECTED", lastError: null });
          startPreview();
          return;
        } catch (e) {
          console.warn("[StripDevice] Camera not available:", e.message);
        }
      }
      setState({ mode: "SIMULATION", camera: "UNAVAILABLE", lastError: null });
      startPreview();
    }

    function stop() {
      stopPreview();
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      if (videoEl) videoEl.srcObject = null;
      setState({ camera: "UNAVAILABLE", mode: "SIMULATION" });
    }

    function setLighting(on) {
      setState({ lighting: on ? "ON" : "OFF" });
    }

    function setROI(roi) {
      Object.assign(R, StripAnalysis.normalizeROI(roi));
    }

    function getROI() { return { ...R }; }

    /* ── Preview loop ──────────────────────────────────────────────── */

    function startPreview() {
      stopPreview();
      previewTimer = setInterval(renderPreview, PREVIEW_INTERVAL);
    }
    function stopPreview() {
      if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    }

    function renderPreview() {
      if (!viewCanvas) return;
      const ctx = viewCanvas.getContext("2d");
      if (!ctx) return;
      drawCurrentFrame(ctx, viewCanvas.width, viewCanvas.height);
      drawROIOverlay(ctx, viewCanvas.width, viewCanvas.height);
    }

    function drawCurrentFrame(ctx, w, h) {
      ctx.clearRect(0, 0, w, h);
      if (state.mode === "LIVE_CAMERA" && videoEl && videoEl.readyState >= 2) {
        const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
        if (!vw || !vh) { ctx.fillStyle = "#060a10"; ctx.fillRect(0, 0, w, h); return; }
        const scale = Math.max(w / vw, h / vh);
        ctx.drawImage(videoEl, (w - vw * scale) / 2, (h - vh * scale) / 2, vw * scale, vh * scale);
      } else {
        drawSyntheticFrame(ctx, w, h);
      }
    }

    /* Synthetic simulation frame: dark enclosure + colour strip zone.
       The strip colour is derived from the CURRENT SIMULATED pH value
       (via DashboardData.phZone), NOT from invented RGB physics. */
    function drawSyntheticFrame(ctx, w, h) {
      const lit = state.lighting === "ON";
      const brightness = lit ? 1.0 : 0.12;
      ctx.fillStyle = `rgb(${Math.round(14 * brightness)},${Math.round(21 * brightness)},${Math.round(30 * brightness)})`;
      ctx.fillRect(0, 0, w, h);

      /* Enclosure body hint */
      const bx = w * 0.06, by = h * 0.08, bw = w * 0.88, bh = h * 0.84;
      ctx.fillStyle = `rgb(${Math.round(22 * brightness)},${Math.round(28 * brightness)},${Math.round(38 * brightness)})`;
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill();

      /* Strip area */
      const sx = w * R.x, sy = h * R.y, sw = w * R.w, sh = h * R.h;
      const phVal = typeof getSimulatedPH === "function" ? getSimulatedPH() : 6.0;
      const zone = typeof window.DashboardData !== "undefined" && window.DashboardData.phZone
        ? window.DashboardData.phZone(phVal) : { id: "blue" };
      const stripCol = SYNTH_PALETTE[zone.id] || SYNTH_PALETTE.blue;
      ctx.fillStyle = stripCol;
      ctx.globalAlpha = lit ? 0.95 : 0.08;
      ctx.fillRect(sx, sy, sw, sh);
      ctx.globalAlpha = 1;

      /* Subtle noise when lit */
      if (lit) {
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.02})`;
          ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
        }
      }
    }

    function drawROIOverlay(ctx, w, h) {
      const sx = Math.round(R.x * w), sy = Math.round(R.y * h);
      const sw = Math.round(R.w * w), sh = Math.round(R.h * h);
      ctx.strokeStyle = "rgba(34,211,238,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
    }

    /* ── Capture + Analyze pipeline ────────────────────────────────── */

    function captureAndAnalyze() {
      if (state.processing === "ANALYZING" || state.processing === "CAPTURING") return;
      setProc("CAPTURING");

      /* Downscale to avoid large-image memory usage (performance §34). */
      const srcW = state.mode === "LIVE_CAMERA" && videoEl ? videoEl.videoWidth : 640;
      const srcH = state.mode === "LIVE_CAMERA" && videoEl ? videoEl.videoHeight : 480;
      const scale = Math.min(1, MAX_ANALYSIS_W / srcW);
      const cw = Math.round(srcW * scale), ch = Math.round(srcH * scale);
      workCanvas.width = cw; workCanvas.height = ch;

      /* Render current frame onto the work canvas */
      workCtx.clearRect(0, 0, cw, ch);
      if (state.mode === "LIVE_CAMERA" && videoEl && videoEl.readyState >= 2) {
        const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
        if (!vw || !vh) { setProc("ERROR"); fireResult({ ok: false, code: "NO_IMAGE", message: "Camera returned no frame." }); return; }
        const sc = Math.max(cw / vw, ch / vh);
        workCtx.drawImage(videoEl, (cw - vw * sc) / 2, (ch - vh * sc) / 2, vw * sc, vh * sc);
      } else {
        drawSyntheticFrame(workCtx, cw, ch);
      }

      /* YIELD to let the UI repaint, then continue asynchronously */
      setTimeout(() => runAnalysis(workCtx, cw, ch), 35);
    }

    function runAnalysis(ctx, cw, ch) {
      setProc("ANALYZING");

      setTimeout(() => {
        try {
          const imgData = StripAnalysis.extractROI(ctx, R, cw, ch);
          if (!imgData) {
            setProc("READY"); fireResult({ ok: false, code: "NO_ROI", message: "Region of interest could not be extracted." }); return;
          }
          const stats = StripAnalysis.analyzePixels(imgData);
          const quality = StripAnalysis.assessQuality(stats);
          if (!quality.ok) {
            setProc("ERROR"); fireResult({ ok: false, code: "QUALITY", message: quality.issues.map(i => i.message).join(" "), quality, rgb: stats || null }); return;
          }

          const rgb = { r: stats.r, g: stats.g, b: stats.b };
          const hue = stats.hsv;
          let result;

          if (typeof window.StripCalibration !== "undefined" && window.StripCalibration.isCalibrated()) {
            const m = StripAnalysis.matchCalibrated(rgb, window.StripCalibration.listPoints());
            if (!m || m.dist > 160) {
              fireResult({
                ok: false, code: "OUT_OF_RANGE",
                message: "Color outside calibrated reference range - recalibrate or re-capture.",
                rgb, confidence: m ? m.confidence : 0, quality,
              });
              setProc("ERROR");
              return;
            }
            result = {
              ok: true, rgb, confidence: m.confidence,
              method: "CALIBRATED_MATCH",
              ph: { value: m.point.ph, display: m.point.ph.toFixed(1) },
              distToNearest: Math.round(m.dist),
              quality,
            };
          } else {
            const zoneId = StripAnalysis.estimateZoneFromHue(hue);
            const zones = typeof window.DashboardData !== "undefined" ? window.DashboardData.PH_ZONES : [];
            const zone = zones.find(z => z.id === zoneId) || zones[zones.length - 1] || {};
            const midStr = zone.range || "--";
            const mid = (zone.min + zone.max) / 2;
            result = {
              ok: true, rgb, confidence: StripAnalysis.confidenceUncalibrated(hue),
              method: "UNCALIBRATED_ESTIMATE",
              ph: { value: Math.round(mid * 10) / 10, display: midStr },
              quality, hue,
            };
          }

          lastCapture = { rgb, ts: new Date().toISOString() };
          setProc("COMPLETE");
          fireResult(result);
        } catch (e) {
          console.error("[StripDevice] analysis error", e);
          setProc("ERROR"); fireResult({ ok: false, code: "PROCESSING_ERROR", message: "Unable to process image." });
        }
      }, 40);
    }

    function calibrateLastCapture(ph) {
      if (!lastCapture) return { ok: false, error: "No capture available. Capture first." };
      return window.StripCalibration.addPoint(ph, lastCapture.rgb);
    }

    function setProc(p) {
      state.processing = p;
      if (onProcessing) onProcessing(p);
    }
    function fireResult(r) { if (onResult) onResult(r); }

    return {
      start, stop, setLighting, setROI, getROI,
      captureAndAnalyze, calibrateLastCapture,
      renderPreview, drawCurrentFrame, drawROIOverlay,
      get state() { return { ...state }; },
      get lastCapture() { return lastCapture; },
    };
  }

  return { createManager };
})();
