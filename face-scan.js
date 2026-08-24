"use strict";

window.FaceScan = (function () {

  const INPUT_SIZE = 320;
  const SCAN_DURATION = 5000;

  function create({ videoEl, onScanProgress, onScanComplete }) {
    let modelsReady = false;
    let scanning = false;

    async function loadModels() {
      if (typeof faceapi === "undefined") return false;
      const paths = [
        (window.location.origin || "") + "/models",
        "/models",
        "./models",
      ];
      for (const base of paths) {
        try {
          await faceapi.nets.tinyFaceDetector.loadFromUri(base);
          await faceapi.nets.faceLandmark68Net.loadFromUri(base);
          await faceapi.nets.faceRecognitionNet.loadFromUri(base);
          modelsReady = true;
          console.log("[FaceScan] Models loaded from:", base);
          return true;
        } catch (e) {
          console.warn("[FaceScan] Model load failed from", base);
        }
      }
      return false;
    }

    async function ensureModels() {
      if (modelsReady) return true;
      return await loadModels();
    }

    function detectOnce() {
      if (!modelsReady || !videoEl.videoWidth) return Promise.resolve(null);
      const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: 0.35 });
      return faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks(true).withFaceDescriptor();
    }

    async function waitForStableFace() {
      await ensureModels();
      let stableCount = 0;
      while (stableCount < 3) {
        const result = await detectOnce();
        if (!result || result.detection.score < 0.45) { stableCount = 0; await sleep(100); continue; }
        const box = result.detection.box;
        const cutOff = box.x < 10 || box.y < 10 || (box.x + box.width) > (videoEl.videoWidth - 10) || box.width < 50;
        if (cutOff) { stableCount = 0; await sleep(100); continue; }
        stableCount++;
        await sleep(100);
      }
      return true;
    }

    function startScan() {
      if (scanning) return Promise.resolve(null);
      scanning = true;

      return new Promise(resolve => {
        let elapsed = 0;
        let frames = [];

        const progressTimer = setInterval(() => {
          elapsed += 100;
          const secs = Math.ceil((SCAN_DURATION - elapsed) / 1000);
          if (onScanProgress) onScanProgress(secs);
        }, 100);

        const detectLoop = async () => {
          if (!scanning) return;
          try {
            const result = await detectOnce();
            if (result) {
              frames.push({
                landmarks: result.landmarks,
                descriptor: result.descriptor,
                box: result.detection.box,
                score: result.detection.score,
              });
            }
          } catch (e) { /* skip frame */ }

          if (elapsed >= SCAN_DURATION || frames.length >= 40) {
            clearInterval(progressTimer);
            scanning = false;
            if (frames.length > 0) {
              const avg = analyzeFrames(frames);
              if (onScanComplete) onScanComplete(avg);
              resolve(avg);
            } else {
              if (onScanComplete) onScanComplete(null);
              resolve(null);
            }
          } else {
            setTimeout(detectLoop, 30);
          }
        };

        detectLoop();
      });
    }

    function analyzeFrames(frames) {
      const last = frames[frames.length - 1];
      const avgLandmarks = computeAvgLandmarks(frames.map(f => f.landmarks));
      const avgDescriptor = computeAvgDescriptor(frames.map(f => f.descriptor));
      return { landmarks: avgLandmarks, descriptor: avgDescriptor, box: last.box, score: last.score, frameCount: frames.length };
    }

    function computeAvgLandmarks(landmarksList) {
      const count = landmarksList.length;
      const positions = landmarksList[0].positions;
      const avg = [];
      for (let i = 0; i < positions.length; i++) {
        let sx = 0, sy = 0;
        for (const lm of landmarksList) { sx += lm.positions[i].x; sy += lm.positions[i].y; }
        avg.push({ x: sx / count, y: sy / count });
      }
      return { positions: avg };
    }

    function computeAvgDescriptor(descriptors) {
      const len = descriptors[0].length;
      const avg = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        let sum = 0;
        for (const d of descriptors) sum += d[i];
        avg[i] = sum / descriptors.length;
      }
      return avg;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    return { ensureModels, startScan, detectOnce,
      get isActive() { return scanning; },
      get modelsLoaded() { return modelsReady; },
    };
  }

  return { create };
})();
