/* --------------------
   camera-monitor.js - Camera + face recognition via Python backend.

   Pipeline:
     video frame -> POST to Python backend (/api/face/detect)
                 -> Backend detects face, generates embedding
                 -> Backend matches against enrolled students
                 -> Returns result (recognized, unknown, no_face, etc.)

   State machine:
     IDLE -> FACE_DETECTED -> SCANNING -> RECOGNIZING -> MATCHED/NEW_STUDENT
   -------------------- */

"use strict";

window.FaceMonitor = (function () {

  const SCANNING_DURATION = 5000;    /* 5 seconds scanning period */
  const FRAME_INTERVAL = 500;        /* ms between frame captures */
  const PYTHON_SERVICE_URL = "http://localhost:8001";

  /* ── Canvas Snapshot Helper ──────────────────────────────────── */
  function captureFaceSnapshot(videoEl) {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
    try {
      const canvas = document.createElement("canvas");
      const size = 180;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      const minDim = Math.min(videoEl.videoWidth, videoEl.videoHeight);
      const sx = (videoEl.videoWidth - minDim) / 2;
      const sy = (videoEl.videoHeight - minDim) / 2;

      // Mirror horizontal to match webcam mirror display
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(videoEl, sx, sy, minDim, minDim, 0, 0, size, size);

      return canvas.toDataURL("image/png");
    } catch (e) {
      console.warn("[FaceMonitor] snapshot capture error:", e);
      return null;
    }
  }

  function create({ videoEl, onIdentified, onUnknown, onNoFace, onUnclearFace, onClearFace, onStatus }) {

    let stream = null;
    let timer = null;
    let scanningTimer = null;
    let serviceAvailable = false;

    /* Runtime state machine */
    let currentState = "IDLE";        /* IDLE, SCANNING, RECOGNIZING, MATCHED, NEW_STUDENT */
    let currentStudent = null;
    let lastSnapshot = null;
    let lastEstimated = null;
    let enrollLock = false;
    let scanningStartTime = 0;
    let scanResults = [];             /* collected during scanning period */

    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    /* ── Python service connectivity ──────────────────────────── */

    async function checkServiceHealth() {
      try {
        const response = await fetch(`${PYTHON_SERVICE_URL}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(2000)
        });
        if (response.ok) {
          const data = await response.json();
          serviceAvailable = data.status === "ok" && data.model_loaded;
          if (serviceAvailable) {
            setState({ models: true, error: null });
            console.log("[FaceMonitor] Python service available and model loaded");
          } else {
            setState({ error: "Python face service model not loaded" });
            console.warn("[FaceMonitor] Python service model not loaded");
          }
          return serviceAvailable;
        }
      } catch (e) {
        serviceAvailable = false;
        setState({ error: "Python face service not available at " + PYTHON_SERVICE_URL });
        console.warn("[FaceMonitor] Python service not available:", e.message);
        return false;
      }
    }

    /* ── Known faces registry (local cache from DB) ───────────── */

    let knownFaces = [];

    function setKnownFaces(list) {
      knownFaces = [];
      for (const s of (list || [])) {
        const embs = Array.isArray(s.embeddings) && s.embeddings.length > 0
          ? s.embeddings
          : (Array.isArray(s.embedding) ? [s.embedding] : []);
        for (const emb of embs) {
          if (Array.isArray(emb) && emb.length === 128) {
            knownFaces.push({
              studentId: s.id ?? s.studentId,
              name: s.name,
              age: s.age,
              weightKg: s.weight_kg ?? s.weightKg,
              photo: s.photo || null,
              embedding: emb,
            });
          }
        }
      }
      console.log(`[FaceMonitor] Known faces loaded: ${knownFaces.length}`);
    }

    function addKnownFace(studentId, name, embedding, age, weightKg, photo) {
      knownFaces.push({
        studentId,
        name,
        age: age || null,
        weightKg: weightKg || null,
        photo: photo || null,
        embedding,
      });
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
        setState({ state: "ERROR", error: e.name === "NotAllowedError"
          ? "Camera permission denied" : "Camera unavailable" });
        return false;
      }
      videoEl.srcObject = stream;

      await new Promise(resolve => {
        if (videoEl.readyState >= 1) return resolve();
        videoEl.onloadedmetadata = () => resolve();
      });
      await videoEl.play().catch((e) => console.warn("[FaceMonitor] play() failed:", e));

      /* Check Python service */
      await checkServiceHealth();
      if (!serviceAvailable) {
        setState({ state: "ERROR", error: status.error });
        return false;
      }

      setState({ state: "RUNNING", error: null });
      timer = setInterval(analyzeFrame, FRAME_INTERVAL);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (scanningTimer) { clearTimeout(scanningTimer); scanningTimer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      currentStudent = null;
      currentState = "IDLE";
      lastSnapshot = null;
      emitState();
      setState({ state: "OFF", error: null });
    }

    /* ── Frame analysis via Python backend ──────────────────────── */

    async function analyzeFrame() {
      if (!stream || !videoEl.videoWidth || !serviceAvailable || enrollLock) return;
      
      try {
        /* Capture frame as base64 */
        const frameData = captureFrameBase64(videoEl);
        if (!frameData) return;

        /* Send to Python backend for face detection */
        const response = await fetch(`${PYTHON_SERVICE_URL}/api/face/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: frameData }),
          signal: AbortSignal.timeout(3000)
        });

        if (!response.ok) {
          console.warn("[FaceMonitor] Detection request failed:", response.status);
          return;
        }

        const result = await response.json();
        
        if (result.status === "face_detected" && result.embedding) {
          /* Face detected - try to match against known faces */
          handleFaceDetected(result);
        } else if (result.status === "no_face") {
          handleNoFace();
        } else if (result.status === "multiple_faces") {
          if (onUnclearFace) onUnclearFace("Multiple faces detected. Please show only one face.");
        } else if (result.status === "unclear") {
          if (onUnclearFace) onUnclearFace("Please face the camera directly.");
        }

      } catch (e) {
        console.warn("[FaceMonitor] frame error:", e.message);
      }
    }

    function captureFrameBase64(videoEl) {
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d");
        
        /* Mirror horizontal */
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        
        return canvas.toDataURL("image/jpeg", 0.8);
      } catch (e) {
        return null;
      }
    }

    /* ── State machine handlers ──────────────────────────────── */

    function handleFaceDetected(detectionResult) {
      lastSnapshot = captureFaceSnapshot(videoEl);
      
      if (currentState === "IDLE") {
        /* First face detection - start scanning period */
        currentState = "SCANNING";
        scanningStartTime = Date.now();
        scanResults = [];
        console.log("[FaceMonitor] Face detected, starting scanning period");
        if (onClearFace) onClearFace();
      }

      if (currentState === "SCANNING") {
        /* Collect results during scanning period */
        scanResults.push(detectionResult);
        
        /* Check if scanning period complete */
        if (Date.now() - scanningStartTime >= SCANNING_DURATION) {
          currentState = "RECOGNIZING";
          processScanningResults();
        }
      }
    }

    function processScanningResults() {
      if (scanResults.length === 0) {
        handleNoFace();
        return;
      }

      /* Use the most confident detection */
      const bestResult = scanResults.reduce((best, curr) => 
        (curr.confidence > best.confidence) ? curr : best
      );

      /* Try to match against local known faces first */
      const localMatch = matchLocalFaces(bestResult.embedding);
      
      if (localMatch) {
        /* Matched locally */
        currentStudent = {
          id: localMatch.studentId,
          name: localMatch.name,
          age: localMatch.age,
          weightKg: localMatch.weightKg,
          photo: localMatch.photo || lastSnapshot,
        };
        currentState = "MATCHED";
        console.log("[FaceMonitor] IDENTIFIED locally:", currentStudent.name);
        emitState();
      } else {
        /* Try matching via Python backend */
        matchViaBackend(bestResult.embedding);
      }
    }

    async function matchViaBackend(embedding) {
      try {
        const response = await fetch(`${PYTHON_SERVICE_URL}/api/face/match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embedding }),
          signal: AbortSignal.timeout(3000)
        });

        if (response.ok) {
          const result = await response.json();
          
          if (result.matched && result.student) {
            currentStudent = {
              id: result.student.id,
              name: result.student.name,
              age: result.student.age,
              weightKg: result.student.weight_kg,
              photo: result.student.photo || lastSnapshot,
            };
            currentState = "MATCHED";
            console.log("[FaceMonitor] IDENTIFIED via backend:", currentStudent.name);
            emitState();
          } else {
            /* Unknown face - trigger enrollment */
            currentState = "NEW_STUDENT";
            console.log("[FaceMonitor] UNKNOWN FACE DETECTED -> Trigger Enrollment Flow");
            if (onUnknown) {
              enrollLock = true;
              onUnknown({
                embedding: embedding,
                photo: lastSnapshot,
                estimatedAge: 18,
                estimatedWeight: 55.0,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[FaceMonitor] Backend match failed:", e.message);
        /* Fallback to local matching only */
        currentState = "NEW_STUDENT";
        if (onUnknown) {
          enrollLock = true;
          onUnknown({
            embedding: embedding,
            photo: lastSnapshot,
            estimatedAge: 18,
            estimatedWeight: 55.0,
          });
        }
      }
    }

    function matchLocalFaces(embedding) {
      let best = null;
      let bestScore = -1;

      for (const kf of knownFaces) {
        const score = cosineSimilarity(embedding, kf.embedding);
        if (score > bestScore) {
          bestScore = score;
          best = kf;
        }
      }

      if (best && bestScore >= 0.6) {
        return { ...best, score: bestScore };
      }
      return null;
    }

    function cosineSimilarity(a, b) {
      const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
      const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
      return dotProduct / (normA * normB);
    }

    function handleNoFace() {
      if (currentState === "SCANNING" || currentState === "RECOGNIZING") {
        /* Lost face during scanning - reset */
        currentState = "IDLE";
        scanResults = [];
      }
      
      if (currentStudent) {
        currentStudent = null;
        emitState();
      }
    }

    function emitState() {
      if (currentStudent && onIdentified) onIdentified({ ...currentStudent });
      if (!currentStudent && onNoFace) onNoFace();
    }

    /* Called by main.js after the enrollment modal resolves */
    function resolveUnknown(enrolledStudentOrNull) {
      enrollLock = false;
      currentState = "IDLE";
      scanResults = [];
      
      if (enrolledStudentOrNull) {
        currentStudent = { ...enrolledStudentOrNull };
        emitState();
      } else {
        emitState(); /* back to scanning */
      }
    }

    return {
      start, stop, analyzeFrame,
      setKnownFaces, addKnownFace, resolveUnknown,
      get isPresent() { return !!currentStudent; },
      get student() { return currentStudent ? { ...currentStudent } : null; },
      get status() { return { ...status }; },
      get lastSnapshot() { return lastSnapshot; },
      get lastEstimated() { return lastEstimated; },
    };
  }

  return { create };
})();
