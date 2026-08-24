"use strict";

window.FaceMonitor = (function () {

  const ANALYZE_INTERVAL = 500;
  const INPUT_SIZE = 320;
  const MATCH_THRESHOLD = 0.52;

  function create({ videoEl, onIdentified, onUnknown, onNoFace, onUnclearFace, onClearFace, onStatus }) {

    let stream = null;
    let timer = null;
    let modelsReady = false;
    let currentStudent = null;
    let unknownStreak = 0;
    let identifiedStreak = 0;
    let missCount = 0;
    let enrollLock = false;
    let knownFaces = [];
    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

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
          await Promise.race([
            Promise.all([
              faceapi.nets.tinyFaceDetector.loadFromUri(base),
              faceapi.nets.faceLandmark68Net.loadFromUri(base),
              faceapi.nets.faceRecognitionNet.loadFromUri(base),
            ]),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
          ]);
          modelsReady = true;
          setState({ models: true, error: null });
          console.log("[FaceMonitor] Models loaded from:", base);
          return true;
        } catch (e) {
          console.warn("[FaceMonitor] Model load failed from", base, e.message);
        }
      }
      setState({ state: "ERROR", error: "Face recognition models failed to load." });
      return false;
    }

    function setKnownFaces(list) {
      knownFaces = [];
      for (const s of (list || [])) {
        const embs = Array.isArray(s.embeddings) && s.embeddings.length > 0
          ? s.embeddings
          : (Array.isArray(s.embedding) ? [s.embedding] : []);
        for (const emb of embs) {
          if (Array.isArray(emb) && emb.length === 128) {
            knownFaces.push({
              studentId: s.id ?? s.studentId, name: s.name,
              age: s.age, weightKg: s.weight_kg ?? s.weightKg,
              photo: s.photo || null, descriptor: new Float32Array(emb),
            });
          }
        }
      }
      console.log("[FaceMonitor] Known faces loaded:", knownFaces.length);
    }

    function euclidean(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
      return Math.sqrt(sum);
    }

    function matchDescriptor(desc) {
      let best = null;
      for (const kf of knownFaces) {
        const dist = euclidean(desc, kf.descriptor);
        if (!best || dist < best.dist) best = { dist, student: kf };
      }
      if (best && best.dist < MATCH_THRESHOLD) return { matched: true, student: best.student, dist: best.dist };
      return { matched: false, dist: best ? best.dist : null };
    }

    function addKnownFace(studentId, name, embedding, age, weightKg, photo) {
      knownFaces.push({
        studentId, name, age: age || null, weightKg: weightKg || null,
        photo: photo || null, descriptor: new Float32Array(embedding),
      });
    }

    async function start() {
      if (stream) return true;
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        setState({ state: "ERROR", error: "Camera API unavailable" });
        return false;
      }
      setState({ state: "STARTING", error: null });
      console.log("[FaceMonitor] Requesting camera...");
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        console.log("[FaceMonitor] Camera obtained");
      } catch (e) {
        console.error("[FaceMonitor] Camera error:", e.name);
        setState({ state: "ERROR", error: e.name === "NotAllowedError" ? "Camera permission denied" : "Camera unavailable" });
        return false;
      }
      videoEl.srcObject = stream;
      console.log("[FaceMonitor] Waiting for video...");
      await new Promise(r => {
        if (videoEl.readyState >= 1) return r();
        videoEl.onloadedmetadata = () => r();
        setTimeout(r, 3000);
      });
      console.log("[FaceMonitor] Video ready:", videoEl.videoWidth, "x", videoEl.videoHeight);
      await videoEl.play().catch(e => console.warn("[FaceMonitor] play():", e));
      console.log("[FaceMonitor] Loading models...");
      const loaded = await loadModels();
      if (!loaded) {
        console.error("[FaceMonitor] Models failed, detection unavailable");
        setState({ state: "ERROR", error: "Models failed. Open via HTTP server (not file://). Check console." });
        return false;
      }
      setState({ state: "RUNNING", error: null });
      console.log("[FaceMonitor] RUNNING - detection loop active");
      timer = setInterval(analyzeFrame, ANALYZE_INTERVAL);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      currentStudent = null;
      emitState();
      setState({ state: "OFF", error: null });
    }

    async function analyzeFrame() {
      if (!stream || !videoEl.videoWidth || enrollLock) return;
      if (!modelsReady) return;
      try {
        const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: 0.35 });
        const result = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks(true).withFaceDescriptor();
        if (!result) {
          handleNoFace();
          return;
        }
        const score = result.detection.score || 0;
        const box = result.detection.box;
        const isCutOff = box && (box.x < 10 || box.y < 10 || (box.x + box.width) > (videoEl.videoWidth - 10) || box.width < 50);

        if (score < 0.45 || isCutOff) {
          handleNoFace();
          return;
        }

        missCount = 0;
        const desc = result.descriptor;
        const match = matchDescriptor(desc);
        if (match.matched) handleIdentified(match.student);
        else handleUnknown({ descriptor: Array.from(desc), box });
      } catch (e) {
        console.error("[FaceMonitor] frame error:", e);
      }
    }

    function handleNoFace() {
      identifiedStreak = 0;
      unknownStreak = 0;
      missCount++;
      if (missCount === 5) {
        console.log("[FaceMonitor] Face lost (5 consecutive misses)");
        if (currentStudent) { currentStudent = null; emitState(); }
        if (onNoFace) onNoFace();
      }
    }

    function handleIdentified(student) {
      missCount = 0;
      unknownStreak = 0;
      identifiedStreak++;
      const same = currentStudent && currentStudent.id === student.studentId;
      if (same) return;
      if (identifiedStreak >= 2) {
        currentStudent = { id: student.studentId, name: student.name, age: student.age, weightKg: student.weightKg, photo: student.photo };
        identifiedStreak = 0;
        emitState();
      }
    }

    function handleUnknown(enrollData) {
      identifiedStreak = 0;
      if (currentStudent) {
        missCount++;
        if (missCount >= 5) { currentStudent = null; emitState(); }
        return;
      }
      missCount = 0;
      unknownStreak++;
      if (unknownStreak >= 2) {
        unknownStreak = 0;
        if (onUnknown) { enrollLock = true; onUnknown(enrollData); }
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
      if (enrolledStudentOrNull) { currentStudent = { ...enrolledStudentOrNull }; emitState(); }
      else emitState();
    }

    return {
      start, stop, analyzeFrame,
      setKnownFaces, addKnownFace, resolveUnknown,
      get isPresent() { return !!currentStudent; },
      get student() { return currentStudent ? { ...currentStudent } : null; },
      get status() { return { ...status }; },
    };
  }

  return { create, MATCH_THRESHOLD };
})();
