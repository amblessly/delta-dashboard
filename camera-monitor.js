"use strict";

window.FaceMonitor = (function () {

  const INPUT_SIZE = 320;
  const MATCH_THRESHOLD = 0.55;
  const DETECT_INTERVAL = 300;

  function create({ videoEl, onFaceDetected, onNoFace, onStatus }) {

    let stream = null;
    let timer = null;
    let modelsReady = false;
    let facePresent = false;
    let knownFaces = [];
    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

    /* ── Load face-api.js models ── */
    async function loadModels() {
      if (typeof faceapi === "undefined") {
        setState({ error: "face-api.js not loaded" });
        return false;
      }
      const paths = [
        (window.location.origin || "") + "/models",
        "/models",
        "./models",
      ];
      for (const base of paths) {
        try {
          console.log("[FaceMonitor] Loading models from:", base);
          await Promise.race([
            Promise.all([
              faceapi.nets.tinyFaceDetector.loadFromUri(base),
              faceapi.nets.faceLandmark68Net.loadFromUri(base),
              faceapi.nets.faceRecognitionNet.loadFromUri(base),
            ]),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
          ]);
          modelsReady = true;
          setState({ models: true, error: null });
          console.log("[FaceMonitor] Models loaded:", base);
          return true;
        } catch (e) {
          console.warn("[FaceMonitor] Failed:", base, e.message);
        }
      }
      setState({ state: "ERROR", error: "Models failed to load." });
      return false;
    }

    /* ── Start camera + detection ── */
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
        setState({ state: "ERROR", error: e.name === "NotAllowedError" ? "Camera permission denied" : "Camera unavailable" });
        return false;
      }
      videoEl.srcObject = stream;
      await new Promise(r => {
        if (videoEl.readyState >= 1) return r();
        videoEl.onloadedmetadata = () => r();
        setTimeout(r, 4000);
      });
      await videoEl.play().catch(() => {});
      const loaded = await loadModels();
      if (!loaded) return false;
      setState({ state: "RUNNING", error: null });
      timer = setInterval(detectFrame, DETECT_INTERVAL);
      return true;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (videoEl) videoEl.srcObject = null;
      modelsReady = false;
      facePresent = false;
      setState({ state: "OFF", error: null });
    }

    /* ── Single frame detection ── */
    async function detectFrame() {
      if (!stream || !videoEl.videoWidth || !modelsReady) return;
      try {
        const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: 0.35 });
        const result = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks(true).withFaceDescriptor();

        if (!result) {
          if (facePresent) {
            facePresent = false;
            console.log("[FaceMonitor] Face lost");
            if (onNoFace) onNoFace();
          }
          return;
        }

        const score = result.detection.score || 0;
        const box = result.detection.box;
        const w = videoEl.videoWidth;
        const cutOff = box && (box.x < 10 || box.y < 10 || (box.x + box.width) > (w - 10) || box.width < 50);

        if (score < 0.4 || cutOff) {
          if (facePresent) {
            facePresent = false;
            if (onNoFace) onNoFace();
          }
          return;
        }

        if (!facePresent) {
          facePresent = true;
          console.log("[FaceMonitor] Face detected, score:", score.toFixed(3));
        }

        const descriptor = Array.from(result.descriptor);
        const match = findMatch(descriptor);
        if (onFaceDetected) onFaceDetected(descriptor, match);

      } catch (e) {
        console.error("[FaceMonitor] Error:", e);
      }
    }

    /* ── Match against known faces ── */
    function findMatch(descriptor) {
      let best = null;
      for (const kf of knownFaces) {
        const dist = euclidean(descriptor, kf.descriptor);
        if (!best || dist < best.dist) best = { dist, profile: kf };
      }
      if (best && best.dist < MATCH_THRESHOLD) {
        return { matched: true, profile: best.profile, distance: best.dist };
      }
      return { matched: false, distance: best ? best.dist : null };
    }

    function euclidean(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return Math.sqrt(sum);
    }

    /* ── Known faces management ── */
    function setKnownFaces(profiles) {
      knownFaces = (profiles || []).filter(p => p && p.descriptor && p.descriptor.length === 128);
      console.log("[FaceMonitor] Known faces:", knownFaces.length);
    }

    function addKnownFace(profile) {
      if (profile && profile.descriptor && profile.descriptor.length === 128) {
        knownFaces.push(profile);
      }
    }

    return {
      start, stop, detectFrame,
      setKnownFaces, addKnownFace,
      get isRunning() { return !!timer; },
      get faceDetected() { return facePresent; },
    };
  }

  return { create, MATCH_THRESHOLD };
})();
