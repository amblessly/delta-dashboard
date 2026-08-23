/* --------------------
   camera-monitor.js - Camera feed + face-presence detection.

   Drives the dashboard's biometric gate:
     face in view  -> dashboard shows live values
     no face       -> dashboard zeros out (NO SIGNAL)

   Detection approach (zero dependencies, runs offline):
   a lightweight presence heuristic over the central frame region -
   skin-tone pixel ratio (Kovac RGB rule) + brightness sanity check,
   debounced so brief glitches do not flap the dashboard.
   The detector is isolated in analyzeFrame() so it can be swapped for
   a real face-detection model later without touching the UI or data
   layer. It reports PRESENCE, not identity - no biometric identity
   claim is made.
   -------------------- */

"use strict";

window.FaceMonitor = (function () {

  const ANALYZE_INTERVAL = 350;   /* ms between frame checks */
  const W = 96, H = 72;           /* analysis downscale - fast + small */

  /* Debounce: consecutive frames required to flip state. */
  const HITS_TO_ENTER = 3;
  const MISSES_TO_EXIT = 4;

  /* Presence thresholds for the heuristic. */
  const SKIN_RATIO_MIN = 0.10;    /* >=10% skin-tone pixels in center */
  const BRIGHTNESS_MIN = 28;      /* camera not covered / lens capped */

  function create({ videoEl, onPresence, onStatus }) {

    let stream = null;
    let timer = null;
    let present = false;
    let hitStreak = 0, missStreak = 0;
    const status = { state: "OFF", error: null };

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    async function start() {
      if (stream) return true;
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        setState({ state: "ERROR", error: "Camera API unavailable" });
        return false;
      }
      setState({ state: "STARTING", error: null });
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } },
          audio: false,
        });
      } catch (e) {
        stream = null;
        setState({ state: "ERROR", error: e.name === "NotAllowedError"
          ? "Camera permission denied" : "Camera unavailable" });
        return false;
      }
      videoEl.srcObject = stream;
      await videoEl.play().catch(() => {});
      setState({ state: "RUNNING", error: null });
      timer = setInterval(analyzeFrame, ANALYZE_INTERVAL);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      setPresent(false);
      setState({ state: "OFF", error: null });
    }

    /* ── Frame analysis ─────────────────────────────────────────── */

    function analyzeFrame() {
      if (!stream || !videoEl.videoWidth) return;

      ctx.drawImage(videoEl, 0, 0, W, H);
      const res = analyzeImageData(ctx.getImageData(0, 0, W, H));

      /* Debounced presence flip */
      if (res.faceLikely) {
        hitStreak++; missStreak = 0;
        if (!present && hitStreak >= HITS_TO_ENTER) setPresent(true);
      } else {
        missStreak++; hitStreak = 0;
        if (present && missStreak >= MISSES_TO_EXIT) setPresent(false);
      }
    }

    function analyzeImageData(img) {
      const d = img.data;
      let skin = 0, bright = 0, n = 0;

      /* Central region only - where a face would sit in the kiosk cam. */
      const x0 = Math.round(W * 0.18), x1 = Math.round(W * 0.82);
      const y0 = Math.round(H * 0.08), y1 = Math.round(H * 0.92);

      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * W + x) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          bright += 0.299 * r + 0.587 * g + 0.114 * b;
          n++;
          /* Kovac skin-tone rule (documented heuristic). */
          if (r > 95 && g > 40 && b > 20 &&
              (Math.max(r, g, b) - Math.min(r, g, b)) > 15 &&
              Math.abs(r - g) > 15 && r > g && r > b) {
            skin++;
          }
        }
      }
      const skinRatio = n ? skin / n : 0;
      const avgBright = n ? bright / n : 0;
      return {
        skinRatio,
        avgBright,
        faceLikely: avgBright >= BRIGHTNESS_MIN && skinRatio >= SKIN_RATIO_MIN,
      };
    }

    function setPresent(p) {
      if (present === p) return;
      present = p;
      hitStreak = 0; missStreak = 0;
      if (onPresence) onPresence(p);
    }

    return {
      start, stop, analyzeImageData,
      get isPresent() { return present; },
      get status() { return { ...status }; },
    };
  }

  return { create };
})();
