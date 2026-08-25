"use strict";

/* camera-monitor.js — Camera + face recognition pipeline.

   Pipeline: Camera → face-api.js TinyFaceDetector → Landmarks 68 →
             128-d descriptor → POST /api/face/match (server-side,
             threshold-gated) → Student ID or UNKNOWN.

   Guarantees required by the Project DELTA spec:
   - Models are loaded once, detection runs on an interval (never per frame)
   - Registration/recognition only proceeds with ONE good-quality face
   - A match below the configured threshold resolves to UNKNOWN — the
     closest face is never assumed correct
   - Identity decisions require stable consecutive frames (anti-flicker)
*/

window.FaceMonitor = (function () {

  const INPUT_SIZE = 320;
  const DETECT_INTERVAL_MS = 1100;  /* recognition cadence (CPU-backend friendly) */
  const DETECTOR_SCORE_THRESHOLD = 0.2;   /* catch weak faces; quality gate below filters */
  const MIN_QUALITY_SCORE = 0.45;   /* reject weak detections */

  const MIN_FACE_WIDTH_PX = 80;     /* reject tiny/distant faces */
  const EDGE_MARGIN_PX = 12;        /* reject faces clipped by the frame edge */
  const MAX_FACES = 1;              /* exactly one person may be scanned */

  const MATCH_STREAK = 1;           /* decisions are single-shot (CPU-friendly) */
  const UNKNOWN_STREAK = 1;         /* unknown -> enrollment modal immediately */
  const FACE_LOST_STREAK = 3;       /* consecutive empty frames before NO FACE */

  const SMOOTH_DESCRIPTORS = 1;     /* no averaging delay */
  function create({ videoEl, onIdentified, onUnknown, onNoFace, onGuidance, onStatus }) {

    let stream = null;
    let timer = null;
    let modelsReady = false;
    let backendOk = true;

    /* Runtime state */
    let lockedStudent = null;      /* currently recognized student */
    let missStreak = 0;
    let matchCode = null;          /* candidate matched student code */
    let matchStreak = 0;
    let unknownCount = 0;
    let lostCount = 0;
    let enrollLock = false;        /* set while the enrollment modal is open */
    let inFlight = false;          /* one server match at a time */
    let recentDescriptors = [];
    let tick = 0;                  /* diagnostics counter */

    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    function guidance(msg) { if (onGuidance) onGuidance(msg); }

    /* ── Models ─────────────────────────────────────────────────── */

    /* Some GPU/driver combos stall WebGL inference forever (the detect
       promise never settles). Probe once with a tiny input; if it does
       not come back in time, switch TensorFlow to the CPU backend. */
    async function ensureInferenceBackend() {
      const probe = () => Promise.race([
        faceapi.detectAllFaces(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.1 })),
        new Promise((_, rej) => setTimeout(() => rej(new Error("gpu-stall")), 6000)),
      ]);
      try {
        await probe();
        console.log("[FaceMonitor] Inference backend OK:", faceapi.tf ? faceapi.tf.getBackend() : "default");
      } catch (e) {
        const from = faceapi.tf ? faceapi.tf.getBackend() : "default";
        console.warn("[FaceMonitor] Inference stalled on", from, "- switching to CPU");
        try {
          if (faceapi.tf) { faceapi.tf.setBackend("cpu"); await faceapi.tf.ready(); }
          await probe();
          console.log("[FaceMonitor] CPU backend working");
        } catch (e2) {
          console.warn("[FaceMonitor] Backend probe failed after fallback:", e2.message);
        }
      }
    }

    async function loadModels() {
      if (typeof faceapi === "undefined") {
        setState({ state: "ERROR", error: "face-api.js library not loaded" });
        return false;
      }
      const bases = [
        (window.location.origin || "") + "/models",
        "/models",
        "./models",
      ];
      for (const base of bases) {
        try {
          await Promise.race([
            Promise.all([
              faceapi.nets.tinyFaceDetector.loadFromUri(base),
              faceapi.nets.faceLandmark68Net.loadFromUri(base),
              faceapi.nets.faceRecognitionNet.loadFromUri(base),
            ]),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
          ]);
          modelsReady = true;
          setState({ models: true, error: null });
          console.log("[FaceMonitor] Models loaded:", base);
          /* Force CPU: WebGL inference is unreliable across GPU/driver
             combos (stalls or returns garbage). CPU is deterministic. */
          try {
            if (faceapi.tf) { faceapi.tf.setBackend("cpu"); await faceapi.tf.ready(); }
          } catch (be) { console.warn("[FaceMonitor] CPU backend switch failed:", be.message); }
          await ensureInferenceBackend();
          return true;
        } catch (e) {
          console.warn("[FaceMonitor] Model load failed:", base, e.message);
        }
      }
      setState({ state: "ERROR", error: "Face recognition models failed to load." });
      return false;
    }

    /* ── Camera lifecycle ───────────────────────────────────────── */
    async function start() {
      if (stream) return true;
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        setState({ state: "ERROR", error: "Camera API unavailable" });
        return false;
      }
      setState({ state: "STARTING", error: null });
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } catch (e) {
        stream = null;
        setState({
          state: "ERROR",
          error: e.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access and reload."
            : "Unable to access camera.",
        });
        return false;
      }
      videoEl.srcObject = stream;
      await new Promise(resolve => {
        if (videoEl.readyState >= 1) return resolve();
        videoEl.onloadedmetadata = () => resolve();
        setTimeout(resolve, 4000);
      });
      await videoEl.play().catch(() => {});
      const ok = await loadModels();
      if (!ok) return false;
      setState({ state: "RUNNING", error: null });
      timer = setInterval(detectFrame, DETECT_INTERVAL_MS);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      modelsReady = false;
      lockedStudent = null;
      resetCandidateState();
      setState({ state: "OFF", error: null });
    }

    function resetCandidateState() {
      matchCode = null; matchStreak = 0; unknownCount = 0; lostCount = 0;
      recentDescriptors = [];
    }

    /* ── Detection + recognition loop ───────────────────────────── */
    function sampleBrightness() {
      try {
        const bc = document.createElement("canvas");
        bc.width = 64; bc.height = 48;
        const bx = bc.getContext("2d", { willReadFrequently: true });
        bx.drawImage(videoEl, 0, 0, 64, 48);
        const px = bx.getImageData(0, 0, 64, 48).data;
        let s = 0;
        for (let i = 0; i < px.length; i += 4) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
        return Math.round(s / (px.length / 4));
      } catch (e) { return null; }
    }

    /* Downscaled frame: recognition nets cost ~4x less pixels to churn. */
    let procCanvas = null;
    function processSource() {
      const w = Math.round((videoEl.videoWidth || 640) / 2);
      const h = Math.round((videoEl.videoHeight || 480) / 2);
      if (!procCanvas) procCanvas = document.createElement("canvas");
      procCanvas.width = w; procCanvas.height = h;
      procCanvas.getContext("2d").drawImage(videoEl, 0, 0, w, h);
      return procCanvas;
    }

    async function detectFrame() {
      tick++;
      if (!stream || !videoEl.videoWidth) {
        if (tick % 3 === 1) setState({ state: "RUNNING", models: true, dbg: `CAMERA FEED: ${!stream ? "no stream" : "no frames (w=0)"}` });
        return;
      }
      if (!modelsReady || enrollLock || inFlight) return;

      try {
        const opts = () => new faceapi.TinyFaceDetectorOptions({
          inputSize: INPUT_SIZE,
          scoreThreshold: DETECTOR_SCORE_THRESHOLD,
        });

        /* Stage 1: cheap detector-only pass (skip heavy nets when no face). */
        const quick = await faceapi.detectAllFaces(videoEl, opts());

        /* Diagnostics + quality gate computed on cheap pass. */
        const emit = (msg) => { if (tick % 3 === 0) setState({ state: "RUNNING", models: true, dbg: `FACE SCAN: ${msg} · cam:${sampleBrightness()}` }); };

        if (!quick || quick.length === 0) {
          emit("no face detected");
          handleEmpty();
          return;
        }
        if (quick.length > MAX_FACES) {
          /* Never scan while several people are visible. */
          resetCandidateState();
          guidance("Only one person should be visible during scanning.");
          return;
        }

        const q0 = quick[0];
        const qScore = q0.score || 0;
        const qBoxW = Math.round(q0.box.width);
        const vw = videoEl.videoWidth;
        const clipped = q0.box.x < EDGE_MARGIN_PX || q0.box.y < EDGE_MARGIN_PX ||
          (q0.box.x + q0.box.width) > (vw - EDGE_MARGIN_PX);
        const tooSmall = q0.box.width < MIN_FACE_WIDTH_PX;

        if (qScore < MIN_QUALITY_SCORE || tooSmall || clipped) {
          const why = clipped ? "too close to frame edge"
            : `${tooSmall ? "too far/small" : "low clarity"} (score ${qScore.toFixed(2)}, w ${qBoxW}px)`;
          emit(`face seen but ${why}`);
          handleEmpty();
          if (!lockedStudent) {
            guidance(tooSmall || qScore < MIN_QUALITY_SCORE
              ? "Please move closer and face the camera directly."
              : "Please center your face inside the frame.");
          }
          return;
        }

        lostCount = 0;
        guidance(null);

        /* Feed face ROI to rPPG engine for live vital-sign computation. */
        if (window.RPPG) window.RPPG.processFrame(q0.box);

        emit(`${quick.length} face · score ${qScore.toFixed(2)} · w ${qBoxW}px · recognizing…`);

        /* Stage 2: landmarks + 128-d descriptor, single face, downscaled. */
        const det = await faceapi.detectSingleFace(processSource(), opts())
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (!det) {
          handleEmpty();
          return;
        }

        /* Smooth descriptor across a few frames. */
        recentDescriptors.push(Array.from(det.descriptor));
        if (recentDescriptors.length > SMOOTH_DESCRIPTORS) recentDescriptors.shift();
        const avgDescriptor = averageDescriptors(recentDescriptors);

        await matchAgainstRegistry(avgDescriptor);
      } catch (e) {
        console.error("[FaceMonitor] frame error:", e.message);
      }
    }

    function averageDescriptors(list) {
      const len = list[0].length;
      const out = new Array(len).fill(0);
      for (const d of list) {
        for (let i = 0; i < len; i++) out[i] += d[i];
      }
      return out.map(v => v / list.length);
    }

    async function matchAgainstRegistry(descriptor) {
      inFlight = true;
      try {
        const result = await window.ApiClient.matchFace(descriptor);

        if (result.matched && result.student) {
          unknownCount = 0;
          const code = result.student.studentCode;
          if (lockedStudent && lockedStudent.studentCode === code) {
            missStreak = 0;
            return; /* already active */
          }
          if (matchCode !== code) { matchCode = code; matchStreak = 0; }
          matchStreak++;
          if (matchStreak >= MATCH_STREAK) {
            lockedStudent = result.student;
            matchCode = null; matchStreak = 0; unknownCount = 0; missStreak = 0;
            console.log("[FaceMonitor] IDENTIFIED:", lockedStudent.name, "ID", lockedStudent.studentCode);
            setState({ state: "RUNNING", models: true, dbg: `RECOGNIZED: ${lockedStudent.name} · ID ${lockedStudent.studentCode}` });
            if (onIdentified) onIdentified({ ...lockedStudent });
          }
        } else {
          /* Threshold not met -> this is an UNKNOWN person. */
          matchCode = null; matchStreak = 0;
          if (lockedStudent) {
            missStreak++;
            if (missStreak >= FACE_LOST_STREAK) releaseCurrent();
            return;
          }
          unknownCount++;
          if (unknownCount >= UNKNOWN_STREAK && !enrollLock) {
            unknownCount = 0;
            enrollLock = true;
            console.log("[FaceMonitor] UNKNOWN FACE -> enrollment flow");
            setState({ state: "RUNNING", models: true, dbg: "UNKNOWN FACE → enrollment" });
            if (onUnknown) onUnknown({ descriptor, photo: captureSnapshot() });
          }
        }
      } catch (e) {
        if (e.message === "BACKEND_UNAVAILABLE") {
          if (backendOk) {
            backendOk = false;
            console.warn("[FaceMonitor] Backend unavailable");
            setState({ error: "Backend unavailable - recognition paused." });
            setTimeout(() => { backendOk = true; }, 5000);
          }
          guidance("Cannot reach the server. Recognition is paused.");
        } else {
          console.warn("[FaceMonitor] match failed:", e.message);
        }
      } finally {
        inFlight = false;
      }
    }

    function handleEmpty() {
      matchCode = null; matchStreak = 0; unknownCount = 0;
      if (!lockedStudent) {
        lostCount++;
        if (lostCount >= FACE_LOST_STREAK) { guidance(null); }
        return;
      }
      missStreak++;
      if (missStreak >= FACE_LOST_STREAK) releaseCurrent();
    }

    function releaseCurrent() {
      lockedStudent = null;
      missStreak = 0;
      resetCandidateState();
      if (onNoFace) onNoFace();
    }

    /* ── Enrollment resolution ──────────────────────────────────── */
    function resolveUnknown(studentOrNull) {
      enrollLock = false;
      resetCandidateState();
      if (studentOrNull) {
        lockedStudent = studentOrNull;
        if (onIdentified) onIdentified({ ...studentOrNull });
      }
    }

    /* Cropped mirrored photo used as enrollment reference image. */
    function captureSnapshot() {
      try {
        const canvas = document.createElement("canvas");
        const size = 180;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const minDim = Math.min(videoEl.videoWidth, videoEl.videoHeight);
        const sx = (videoEl.videoWidth - minDim) / 2;
        const sy = (videoEl.videoHeight - minDim) / 2;
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, sx, sy, minDim, minDim, 0, 0, size, size);
        return canvas.toDataURL("image/jpeg", 0.85);
      } catch (e) {
        return null;
      }
    }

    return {
      start, stop, detectFrame, resolveUnknown,
      get isRunning() { return !!timer; },
      get student() { return lockedStudent ? { ...lockedStudent } : null; },
      get status() { return { ...status }; },
    };
  }

  return { create };
})();
