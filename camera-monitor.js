"use strict";

window.FaceMonitor = (function () {

  const ANALYZE_INTERVAL = 300;
  const INPUT_SIZE = 320;
  const MATCH_THRESHOLD = 0.52;

  function create({ videoEl, onFaceDetected, onNoFace, onStatus }) {

    let stream = null;
    let timer = null;
    let modelsReady = false;
    let lastDescriptor = null;
    let knownFaces = [];
    let facePresent = false;
    const status = { state: "OFF", error: null, models: false };

    function setState(patch) {
      Object.assign(status, patch);
      if (onStatus) onStatus({ ...status });
    }

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
          console.log("[FaceMonitor] Trying:", base);
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
          console.log("[FaceMonitor] Models OK:", base);
          return true;
        } catch (e) {
          console.warn("[FaceMonitor] Failed:", base, e.message);
        }
      }
      setState({ state: "ERROR", error: "Models failed. Use HTTP server." });
      return false;
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
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } catch (e) {
        setState({ state: "ERROR", error: e.name === "NotAllowedError" ? "Camera permission denied" : "Camera unavailable" });
        return false;
      }
      videoEl.srcObject = stream;
      await new Promise(r => { if (videoEl.readyState >= 1) return r(); videoEl.onloadedmetadata = () => r(); setTimeout(r, 3000); });
      await videoEl.play().catch(() => {});
      const loaded = await loadModels();
      if (!loaded) return false;
      setState({ state: "RUNNING", error: null });
      timer = setInterval(analyzeFrame, ANALYZE_INTERVAL);
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

    async function analyzeFrame() {
      if (!stream || !videoEl.videoWidth || !modelsReady) return;
      try {
        const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: 0.35 });
        const result = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks(true).withFaceDescriptor();

        if (!result) {
          if (facePresent) {
            facePresent = false;
            lastDescriptor = null;
            console.log("[FaceMonitor] Face LOST");
            if (onNoFace) onNoFace();
          }
          return;
        }

        const score = result.detection.score || 0;
        const box = result.detection.box;
        const cutOff = box && (box.x < 10 || box.y < 10 || (box.x + box.width) > (videoEl.videoWidth - 10) || box.width < 50);

        if (score < 0.45 || cutOff) {
          if (facePresent) {
            facePresent = false;
            lastDescriptor = null;
            if (onNoFace) onNoFace();
          }
          return;
        }

        /* Face detected! */
        if (!facePresent) {
          facePresent = true;
          console.log("[FaceMonitor] Face DETECTED, score:", score.toFixed(3));
        }
        lastDescriptor = result.descriptor;
        if (onFaceDetected) onFaceDetected(Array.from(result.descriptor));

      } catch (e) {
        console.error("[FaceMonitor] error:", e);
      }
    }

    return { start, stop, analyzeFrame, setKnownFaces: () => {} };
  }

  return { create, MATCH_THRESHOLD };
})();
