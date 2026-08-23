/* --------------------
   camera-monitor.js - Camera + face recognition (identity, not just presence).

   Pipeline per analysis tick:
     video frame -> TinyFaceDetector (find face)
                 -> FaceLandmark68Tiny (alignment)
                 -> FaceRecognitionNet (128-d embedding)
                 -> Euclidean distance vs enrolled embeddings
                      best dist < MATCH_THRESHOLD  -> IDENTIFIED (known student)
                      face found but no match      -> UNKNOWN   (enrollment prompt)
                      no face                      -> NO FACE   (dashboard zeros)

   Uses face-api.js models served locally from ./models so the whole
   thing works offline on a Raspberry Pi kiosk. Reports IDENTITY only
   for enrolled students - embeddings are numeric feature vectors, no
   photos are stored.
   -------------------- */

"use strict";

window.FaceMonitor = (function () {

  const ANALYZE_INTERVAL = 900;    /* ms between recognition ticks */
  const INPUT_SIZE = 320;          /* detector input resolution */

  /* Debounce: consecutive results required to flip state. */
  const HITS_TO_IDENTIFY = 2;
  const MISSES_TO_EXIT = 4;

  /* face-api.js standard: Euclidean distance < ~0.5 => same person. */
  const MATCH_THRESHOLD = 0.5;

  function create({ videoEl, onIdentified, onUnknown, onNoFace, onStatus }) {

    let stream = null;
    let timer = null;
    let modelsReady = false;

    /* Runtime state machine */
    let currentStudent = null;       /* {id,name,...} or null */
    let unknownStreak = 0;
    let identifiedStreak = 0;
    let lastDescriptor = null;       /* Float32Array(128) of latest face */
    let enrollLock = false;          /* modal open - pause auto flips */

    /* Enrolled embeddings cache: [{studentId, name, descriptor:Float32Array}] */
    let knownFaces = [];

    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    /* ── Model loading ──────────────────────────────────────────── */

    async function loadModels() {
      if (typeof faceapi === "undefined") {
        setState({ error: "face-api.js not loaded" });
        return false;
      }
      /* Use absolute path so it works on Vercel (any subpath deployment) */
      const base = (typeof window !== "undefined" && window.location?.origin)
        ? window.location.origin + "/models"
        : "/models";
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(base);
        await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
        await faceapi.nets.faceRecognitionNet.loadFromUri(base);
        modelsReady = true;
        setState({ models: true, error: null });
        return true;
      } catch (e) {
        console.warn("[FaceMonitor] model load failed:", e);
        setState({ error: "Model files missing at " + base });
        return false;
      }
    }

    /* ── Known faces registry ───────────────────────────────────── */

    function setKnownFaces(list) {
      knownFaces = (list || [])
        .filter(r => Array.isArray(r.embedding) && r.embedding.length === 128)
        .map(r => ({
          studentId: r.studentId,
          name: r.name,
          descriptor: new Float32Array(r.embedding),
        }));
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
        if (!best || dist < best.dist) best = { dist, studentId: kf.studentId, name: kf.name };
      }
      if (best && best.dist < MATCH_THRESHOLD) {
        return { matched: true, studentId: best.studentId, name: best.name, dist: best.dist };
      }
      return { matched: false, dist: best ? best.dist : null };
    }

    /* Exposed so main.js can attach an enrollment to the right student. */
    function addKnownFace(studentId, name, embedding) {
      knownFaces.push({
        studentId,
        name,
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
      await videoEl.play().catch(() => {});

      await loadModels();
      if (!modelsReady) { setState({ state: "ERROR", error: status.error }); return false; }

      setState({ state: "RUNNING", error: null });
      console.log("[FaceMonitor] Camera started, models ready, beginning analysis loop");
      timer = setInterval(analyzeFrame, ANALYZE_INTERVAL);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      currentStudent = null;
      lastDescriptor = null;
      emitState();
      setState({ state: "OFF", error: null });
    }

    /* ── Recognition loop ───────────────────────────────────────── */

    async function analyzeFrame() {
      if (!stream || !videoEl.videoWidth || !modelsReady || enrollLock) return;
      try {
        const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: 0.5 });
        const result = await faceapi
          .detectSingleFace(videoEl, opts)
          .withFaceLandmarks(true)
          .withFaceDescriptor();

        if (!result) { handleNoFace(); return; }

        const desc = result.descriptor;
        lastDescriptor = desc;

        const match = matchDescriptor(desc);
        console.log("[FaceMonitor] face detected, match:", match.matched ? "yes (dist=" + match.dist + ")" : "no (best=" + match.dist + ")");
        if (match.matched) handleIdentified(match);
        else handleUnknown();
      } catch (e) {
        console.warn("[FaceMonitor] frame error:", e.message);
      }
    }

    function handleNoFace() {
      identifiedStreak = 0;
      unknownStreak = 0;
      if (currentStudent) {
        missCount++;
        if (missCount >= MISSES_TO_EXIT) {
          currentStudent = null;
          lastDescriptor = null;
          emitState();
        }
      } else {
        missCount = 0;
        emitState();
      }
    }

    let missCount = 0;

    function handleIdentified(match) {
      missCount = 0;
      unknownStreak = 0;
      identifiedStreak++;

      const sameStudent = currentStudent && currentStudent.id === match.studentId;
      if (sameStudent) return;

      console.log("[FaceMonitor] identified streak:", identifiedStreak, "/", HITS_TO_IDENTIFY, "student:", match.name);
      if (identifiedStreak >= HITS_TO_IDENTIFY) {
        currentStudent = { id: match.studentId, name: match.name };
        identifiedStreak = 0;
        console.log("[FaceMonitor] EMIT IDENTIFIED:", currentStudent);
        emitState();
      }
    }

    function handleUnknown() {
      identifiedStreak = 0;
      if (currentStudent) {
        /* A face is present but does not match the current student -
           count misses until we drop them (person changed). */
        missCount++;
        console.log("[FaceMonitor] unknown face but have currentStudent, miss:", missCount);
        if (missCount >= MISSES_TO_EXIT) {
          currentStudent = null;
          console.log("[FaceMonitor] EMIT NO FACE (dropped current)");
          emitState();
        }
        return;
      }
      missCount = 0;
      unknownStreak++;
      console.log("[FaceMonitor] unknown streak:", unknownStreak, "/", HITS_TO_IDENTIFY);
      if (unknownStreak >= HITS_TO_IDENTIFY) {
        unknownStreak = 0;
        console.log("[FaceMonitor] EMIT UNKNOWN");
        if (onUnknown) {
          enrollLock = true;   /* wait for main.js enrollment decision */
          onUnknown(lastDescriptor ? Array.from(lastDescriptor) : null);
        }
      }
    }

    function emitState() {
      if (currentStudent && onIdentified) onIdentified({ ...currentStudent });
      if (!currentStudent && onNoFace) onNoFace();
    }

    /* Called by main.js after the enrollment modal resolves. */
    function resolveUnknown(enrolledStudentOrNull) {
      enrollLock = false;
      unknownStreak = 0;
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
      _euclidean: euclidean, _matchDescriptor: matchDescriptor,
      get isPresent() { return !!currentStudent; },
      get student() { return currentStudent ? { ...currentStudent } : null; },
      get status() { return { ...status }; },
      get lastDescriptor() { return lastDescriptor ? Array.from(lastDescriptor) : null; },
    };
  }

  return { create, MATCH_THRESHOLD };
})();
