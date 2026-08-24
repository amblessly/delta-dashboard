/* --------------------
   camera-monitor.js - Camera + face recognition.

   Tries Python backend first (port 8001), falls back to face-api.js.
   -------------------- */

"use strict";

window.FaceMonitor = (function () {

  const ANALYZE_INTERVAL = 500;
  const INPUT_SIZE = 320;
  const SCANNING_DURATION = 5000;
  const PYTHON_SERVICE_URL = "http://localhost:8001";
  const MATCH_THRESHOLD = 0.52;

  /* ── Canvas Snapshot Helper ──────────────────────────────────── */
  function captureFaceSnapshot(videoEl, box) {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
    try {
      const canvas = document.createElement("canvas");
      const size = 180;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      if (box && box.width && box.height) {
        const padX = box.width * 0.25;
        const padY = box.height * 0.25;
        const sx = Math.max(0, box.x - padX);
        const sy = Math.max(0, box.y - padY);
        const sw = Math.min(videoEl.videoWidth - sx, box.width + padX * 2);
        const sh = Math.min(videoEl.videoHeight - sy, box.height + padY * 2);
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, size, size);
      } else {
        const minDim = Math.min(videoEl.videoWidth, videoEl.videoHeight);
        const sx = (videoEl.videoWidth - minDim) / 2;
        const sy = (videoEl.videoHeight - minDim) / 2;
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, sx, sy, minDim, minDim, 0, 0, size, size);
      }
      return canvas.toDataURL("image/png");
    } catch (e) {
      console.warn("[FaceMonitor] snapshot capture error:", e);
      return null;
    }
  }

  function create({ videoEl, onIdentified, onUnknown, onNoFace, onUnclearFace, onClearFace, onStatus }) {

    let stream = null;
    let timer = null;
    let modelsReady = false;
    let usePythonBackend = false;

    /* Runtime state machine */
    let currentStudent = null;
    let unknownStreak = 0;
    let identifiedStreak = 0;
    let lastDescriptor = null;
    let lastSnapshot = null;
    let enrollLock = false;
    let missCount = 0;

    /* Enrolled embeddings cache */
    let knownFaces = [];

    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    /* ── Check Python Backend ──────────────────────────────────── */

    async function checkPythonBackend() {
      try {
        const response = await fetch(`${PYTHON_SERVICE_URL}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(2000)
        });
        if (response.ok) {
          const data = await response.json();
          if (data.status === "ok" && data.model_loaded) {
            usePythonBackend = true;
            console.log("[FaceMonitor] Python backend available, using server-side detection");
            setState({ models: true, error: null });
            return true;
          }
        }
      } catch (e) {
        console.log("[FaceMonitor] Python backend not available, using face-api.js");
      }
      return false;
    }

    /* ── Model loading (face-api.js fallback) ──────────────────── */

    async function loadModels() {
      if (typeof faceapi === "undefined") {
        setState({ error: "face-api.js library not loaded" });
        return false;
      }
      const paths = [
        (window.location.origin || "") + "/models",
        "/models",
        "./models",
      ];
      for (const base of paths) {
        try {
          console.log("[FaceMonitor] Trying models from:", base);
          await faceapi.nets.tinyFaceDetector.loadFromUri(base);
          await faceapi.nets.faceLandmark68Net.loadFromUri(base);
          await faceapi.nets.faceRecognitionNet.loadFromUri(base);
          modelsReady = true;
          setState({ models: true, error: null });
          console.log("[FaceMonitor] Models loaded successfully from:", base);
          return true;
        } catch (e) {
          console.warn("[FaceMonitor] Model load failed from", base, ":", e.message);
        }
      }
      setState({ error: "Face recognition models failed to load. Check /models folder." });
      return false;
    }

    /* ── Known faces registry ───────────────────────────────────── */

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
              descriptor: new Float32Array(emb),
            });
          }
        }
      }
      console.log(`[FaceMonitor] Known faces loaded: ${knownFaces.length}`);
    }

    function euclidean(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return Math.sqrt(sum);
    }

    function matchDescriptor(desc) {
      let best = null;
      for (const kf of knownFaces) {
        const dist = euclidean(desc, kf.descriptor);
        if (!best || dist < best.dist) {
          best = { dist, student: kf };
        }
      }
      if (best && best.dist < MATCH_THRESHOLD) {
        return { matched: true, student: best.student, dist: best.dist };
      }
      return { matched: false, dist: best ? best.dist : null };
    }

    function addKnownFace(studentId, name, embedding, age, weightKg, photo) {
      knownFaces.push({
        studentId,
        name,
        age: age || null,
        weightKg: weightKg || null,
        photo: photo || null,
        descriptor: new Float32Array(embedding),
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

      /* Try Python backend first, then fall back to face-api.js */
      const pythonAvailable = await checkPythonBackend();
      if (!pythonAvailable) {
        await loadModels();
        if (!modelsReady) { setState({ state: "ERROR", error: status.error }); return false; }
      }

      setState({ state: "RUNNING", error: null });
      timer = setInterval(analyzeFrame, ANALYZE_INTERVAL);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      currentStudent = null;
      lastDescriptor = null;
      lastSnapshot = null;
      emitState();
      setState({ state: "OFF", error: null });
    }

    /* ── Recognition loop ───────────────────────────────────────── */

    async function analyzeFrame() {
      if (!stream || !videoEl.videoWidth || enrollLock) return;
      if (!usePythonBackend && !modelsReady) return;

      try {
        if (usePythonBackend) {
          await analyzeFramePython();
        } else {
          await analyzeFrameLocal();
        }
      } catch (e) {
        console.warn("[FaceMonitor] frame error:", e.message);
      }
    }

    /* Python backend analysis */
    async function analyzeFramePython() {
      const frameData = captureFrameBase64(videoEl);
      if (!frameData) return;

      const response = await fetch(`${PYTHON_SERVICE_URL}/api/face/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: frameData }),
        signal: AbortSignal.timeout(3000)
      });

      if (!response.ok) return;

      const result = await response.json();
      lastSnapshot = captureFaceSnapshot(videoEl);

      if (result.status === "face_detected" && result.embedding) {
        /* Try local matching first */
        const localMatch = matchDescriptor(new Float32Array(result.embedding));
        if (localMatch.matched) {
          handleIdentified(localMatch.student);
        } else {
          /* Try backend matching */
          try {
            const matchResponse = await fetch(`${PYTHON_SERVICE_URL}/api/face/match`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ embedding: result.embedding }),
              signal: AbortSignal.timeout(3000)
            });
            if (matchResponse.ok) {
              const matchResult = await matchResponse.json();
              if (matchResult.matched && matchResult.student) {
                handleIdentified({
                  studentId: matchResult.student.id,
                  name: matchResult.student.name,
                  age: matchResult.student.age,
                  weightKg: matchResult.student.weight_kg,
                  photo: matchResult.student.photo,
                });
              } else {
                handleUnknown({ embedding: result.embedding, photo: lastSnapshot });
              }
            }
          } catch (e) {
            handleUnknown({ embedding: result.embedding, photo: lastSnapshot });
          }
        }
      } else if (result.status === "no_face") {
        handleNoFace();
      } else if (result.status === "multiple_faces") {
        if (onUnclearFace) onUnclearFace("Multiple faces detected.");
      } else if (result.status === "unclear") {
        if (onUnclearFace) onUnclearFace("Please face the camera directly.");
      }
    }

    /* Local face-api.js analysis */
    async function analyzeFrameLocal() {
      const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: 0.35 });
      const result = await faceapi
        .detectSingleFace(videoEl, opts)
        .withFaceLandmarks(true)
        .withFaceDescriptor();

      if (!result) {
        handleNoFace();
        return;
      }

      const score = result.detection?.score || 0;
      const box = result.detection?.box;

      const isCutOff = box && (
        box.x < 10 || box.y < 10 ||
        (box.x + box.width) > (videoEl.videoWidth - 10) ||
        box.width < 50
      );

      if (score < 0.45 || isCutOff) {
        if (onUnclearFace) onUnclearFace("Please face the camera directly.");
      } else {
        if (onClearFace) onClearFace();
      }

      const desc = result.descriptor;
      lastDescriptor = desc;
      lastSnapshot = captureFaceSnapshot(videoEl, box);

      const match = matchDescriptor(desc);
      if (match.matched) {
        handleIdentified(match.student);
      } else {
        handleUnknown({ descriptor: Array.from(desc), photo: lastSnapshot });
      }
    }

    function captureFrameBase64(videoEl) {
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.8);
      } catch (e) {
        return null;
      }
    }

    /* ── State handlers ──────────────────────────────────────── */

    function handleNoFace() {
      identifiedStreak = 0;
      unknownStreak = 0;
      if (onClearFace) onClearFace();
      if (currentStudent) {
        missCount++;
        if (missCount >= 3) {
          currentStudent = null;
          lastDescriptor = null;
          lastSnapshot = null;
          emitState();
        }
      } else {
        missCount = 0;
        emitState();
      }
    }

    function handleIdentified(student) {
      missCount = 0;
      unknownStreak = 0;
      identifiedStreak++;

      const sameStudent = currentStudent && currentStudent.id === student.studentId;
      if (sameStudent) return;

      if (identifiedStreak >= 2) {
        currentStudent = {
          id: student.studentId,
          name: student.name,
          age: student.age,
          weightKg: student.weightKg,
          photo: student.photo || lastSnapshot,
        };
        identifiedStreak = 0;
        console.log("[FaceMonitor] IDENTIFIED:", currentStudent.name);
        emitState();
      }
    }

    function handleUnknown(enrollData) {
      identifiedStreak = 0;
      if (currentStudent) {
        missCount++;
        if (missCount >= 3) {
          currentStudent = null;
          emitState();
        }
        return;
      }
      missCount = 0;
      unknownStreak++;
      if (unknownStreak >= 2) {
        unknownStreak = 0;
        console.log("[FaceMonitor] UNKNOWN FACE -> Enrollment Flow");
        if (onUnknown) {
          enrollLock = true;
          onUnknown(enrollData);
        }
      }
    }

    function emitState() {
      if (currentStudent && onIdentified) onIdentified({ ...currentStudent });
      if (!currentStudent && onNoFace) onNoFace();
    }

    function resolveUnknown(enrolledStudentOrNull) {
      enrollLock = false;
      unknownStreak = 0;
      identifiedStreak = 0;
      if (enrolledStudentOrNull) {
        currentStudent = { ...enrolledStudentOrNull };
        emitState();
      } else {
        emitState();
      }
    }

    return {
      start, stop, analyzeFrame,
      setKnownFaces, addKnownFace, resolveUnknown,
      get isPresent() { return !!currentStudent; },
      get student() { return currentStudent ? { ...currentStudent } : null; },
      get status() { return { ...status }; },
      get lastDescriptor() { return lastDescriptor ? Array.from(lastDescriptor) : null; },
      get lastSnapshot() { return lastSnapshot; },
    };
  }

  return { create, MATCH_THRESHOLD };
})();
