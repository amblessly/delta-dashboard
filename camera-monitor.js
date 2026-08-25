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
  const DETECT_INTERVAL_MS = 450;   /* recognition cadence */
  const DETECTOR_SCORE_THRESHOLD = 0.35;
  const MIN_QUALITY_SCORE = 0.5;    /* reject weak detections */
  const MIN_FACE_WIDTH_PX = 80;     /* reject tiny/distant faces */
  const EDGE_MARGIN_PX = 12;        /* reject faces clipped by the frame edge */
  const MAX_FACES = 1;              /* exactly one person may be scanned */

  const MATCH_STREAK = 2;           /* consecutive matches before IDENTIFIED */
  const UNKNOWN_STREAK = 3;         /* consecutive non-matches before NEW STUDENT */
  const FACE_LOST_STREAK = 3;       /* consecutive empty frames before NO FACE */

  const SMOOTH_DESCRIPTORS = 3;     /* averaged descriptors reduce jitter */

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

    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    function guidance(msg) { if (onGuidance) onGuidance(msg); }

    /* ── Models ─────────────────────────────────────────────────── */
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
    async function detectFrame() {
      if (!stream || !videoEl.videoWidth || !modelsReady || enrollLock || inFlight) return;

      try {
        const opts = new faceapi.TinyFaceDetectorOptions({
          inputSize: INPUT_SIZE,
          scoreThreshold: DETECTOR_SCORE_THRESHOLD,
        });
        const detections = await faceapi.detectAllFaces(videoEl, opts)
          .withFaceLandmarks(true)
          .withFaceDescriptors();

        if (!detections || detections.length === 0) {
          handleEmpty();
          return;
        }

        if (detections.length > MAX_FACES) {
          /* Never scan while several people are visible. */
          resetCandidateState();
          guidance("Only one person should be visible during scanning.");
          return;
        }

        const det = detections[0];
        const score = det.detection.score || 0;
        const box = det.detection.box;
        const vw = videoEl.videoWidth;
        const clipped = box.x < EDGE_MARGIN_PX || box.y < EDGE_MARGIN_PX ||
          (box.x + box.width) > (vw - EDGE_MARGIN_PX);
        const tooSmall = box.width < MIN_FACE_WIDTH_PX;

        if (score < MIN_QUALITY_SCORE || tooSmall || clipped) {
          handleEmpty();
          if (!lockedStudent) {
            guidance(score < MIN_QUALITY_SCORE || tooSmall
              ? "Please move closer and face the camera directly."
              : "Please center your face inside the frame.");
          }
          return;
        }

        lostCount = 0;
        guidance(null);

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
