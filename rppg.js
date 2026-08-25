/**
 * rppg.js — Remote photoplethysmography (rPPG) from webcam video.
 *
 * Extracts pulse signal from subtle colour changes in facial skin caused by
 * blood-flow, then derives heart rate (BPM), HRV (RMSSD), respiration rate,
 * and a stress index.  All computation runs in the browser; no external API
 * is called from this module.
 *
 * Public API:
 *   RPPG.start(videoEl)          – begin sampling (call once at boot)
 *   RPPG.processFrame(faceBox)   – call on every detection tick with face box
 *   RPPG.getVitals()             – latest computed vitals or null
 *   RPPG.stop()                  – pause sampling
 *   RPPG.getSignal()             – raw green-channel waveform for visualiser
 */
window.RPPG = (() => {
  /* ── config ─────────────────────────────────────────────── */
  const SAMPLE_INTERVAL = 34;          /* ≈30 fps (34 ms) */
  const WINDOW_SEC     = 30;           /* sliding analysis window */
  const MIN_WARMUP_SEC = 12;           /* seconds before first estimate */
  const RESAMPLE_HZ    = 30;           /* resample to uniform rate */
  const HAMMER_HEAD_SIZE = 6;          /* pixel ROI side length (centered on forehead) */

  /* ── state ──────────────────────────────────────────────── */
  let videoEl       = null;
  let offCanvas     = null;
  let offCtx        = null;
  let timerId       = null;
  let faceBox       = null;            /* {x,y,width,height} in video coords */
  let samples       = [];              /* [{t, g}] */
  let latestVitals  = null;
  let lastAnalyseMs = 0;
  const ANALYSE_GAP = 2500;            /* re-analyse every 2.5 s */

  /* ── bootstrap ──────────────────────────────────────────── */
  function start(ve) {
    videoEl = ve;
    offCanvas = document.createElement("canvas");
    offCanvas.width = HAMMER_HEAD_SIZE;
    offCanvas.height = HAMMER_HEAD_SIZE;
    offCtx = offCanvas.getContext("2d", { willReadFrequently: true });
    if (!timerId) tick();
  }

  function stop() {
    if (timerId) { clearTimeout(timerId); timerId = null; }
    samples = [];
    latestVitals = null;
    faceBox = null;
  }

  /* ── per-frame sampling ─────────────────────────────────── */
  function tick() {
    try { sampleGreen(); } catch (_) { /* silence */ }
    timerId = setTimeout(tick, SAMPLE_INTERVAL);
  }

  function sampleGreen() {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return;
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;

    /* ROI: centre of the detected face (forehead area). */
    let cx, cy, sz;
    if (faceBox && faceBox.width > 40 && faceBox.height > 40) {
      cx = faceBox.x + faceBox.width * 0.5;
      cy = faceBox.y + faceBox.height * 0.28;   /* upper-third = forehead */
      sz = Math.max(faceBox.width, faceBox.height) * 0.22;
    } else {
      /* fallback: upper-centre of frame */
      cx = vw * 0.5;
      cy = vh * 0.30;
      sz = vw * 0.18;
    }
    sz = Math.max(sz, 8);
    const sx = Math.max(0, Math.min(cx - sz / 2, vw - sz));
    const sy = Math.max(0, Math.min(cy - sz / 2, vh - sz));
    const sw = Math.min(sz, vw - sx);
    const sh = Math.min(sz, vh - sy);
    if (sw < 2 || sh < 2) return;

    offCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, HAMMER_HEAD_SIZE, HAMMER_HEAD_SIZE);
    const px = offCtx.getImageData(0, 0, HAMMER_HEAD_SIZE, HAMMER_HEAD_SIZE).data;
    let greenSum = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      greenSum += px[i + 1]; /* green channel */
    }
    const t = performance.now();
    const g = greenSum / n;
    samples.push({ t, g });

    /* prune to 2× window */
    const cutoff = t - WINDOW_SEC * 2000;
    while (samples.length && samples[0].t < cutoff) samples.shift();
  }

  /* ── resampling to uniform grid ─────────────────────────── */
  function resample(arr, hz) {
    if (arr.length < 2) return { vals: [], dt: 0 };
    const dt = 1000 / hz;
    const out = [];
    const tStart = arr[0].t, tEnd = arr[arr.length - 1].t;
    let j = 0;
    for (let t = tStart; t <= tEnd; t += dt) {
      while (j < arr.length - 2 && arr[j + 1].t < t) j++;
      const a = arr[j], b = arr[j + 1] || a;
      const frac = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      out.push(a.g + (b.g - a.g) * frac);
    }
    return { vals: out, dt };
  }

  /* ── detrend: subtract centred moving average ───────────── */
  function detrend(v, win) {
    const out = new Array(v.length);
    const half = Math.floor(win / 2);
    for (let i = 0; i < v.length; i++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(v.length - 1, i + half); j++) {
        sum += v[j]; cnt++;
      }
      out[i] = v[i] - sum / cnt;
    }
    return out;
  }

  /* ── normalise to zero-mean unit-variance ────────────────── */
  function normalise(v) {
    let sum = 0, sumSq = 0;
    for (let i = 0; i < v.length; i++) { sum += v[i]; sumSq += v[i] * v[i]; }
    const mean = sum / v.length;
    const std = Math.sqrt(Math.max(1e-10, sumSq / v.length - mean * mean));
    return v.map(x => (x - mean) / std);
  }

  /* ── DFT magnitude at candidate frequencies ─────────────── */
  function dftMagnitudes(v, freqs, hz) {
    const N = v.length;
    const mags = new Float64Array(freqs.length);
    for (let fi = 0; fi < freqs.length; fi++) {
      const w = 2 * Math.PI * freqs[fi] / hz;
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        re += v[n] * Math.cos(w * n);
        im += v[n] * Math.sin(w * n);
      }
      mags[fi] = Math.sqrt(re * re + im * im) / N;
    }
    return mags;
  }

  /* ── find dominant peak in frequency band ────────────────── */
  function findPeak(freqs, mags, lo, hi) {
    let bestI = -1, bestM = -1;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= lo && freqs[i] <= hi && mags[i] > bestM) {
        bestM = mags[i]; bestI = i;
      }
    }
    if (bestI < 0) return { freq: 0, mag: 0 };
    return { freq: freqs[bestI], mag: bestM };
  }

  /* ── peak detection in time-domain signal ────────────────── */
  function detectPeaks(v, minGap) {
    const peaks = [];
    for (let i = 1; i < v.length - 1; i++) {
      if (v[i] > v[i - 1] && v[i] >= v[i + 1]) {
        if (!peaks.length || (i - peaks[peaks.length - 1]) >= minGap) {
          peaks.push(i);
        }
      }
    }
    return peaks;
  }

  /* ── RMSSD from inter-peak intervals ────────────────────── */
  function computeRMSSD(peaks, hz) {
    if (peaks.length < 4) return null;
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push((peaks[i] - peaks[i - 1]) / hz * 1000); /* ms */
    }
    let sumSq = 0;
    for (let i = 1; i < intervals.length; i++) {
      const d = intervals[i] - intervals[i - 1];
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / (intervals.length - 1));
  }

  /* ── bandpass filter (simple moving-average difference) ──── */
  function bandpass(v, hz, loHz, hiHz) {
    /* Two-stage MA difference for band-pass */
    const wLong  = Math.max(2, Math.round(hz / loHz));
    const wShort = Math.max(2, Math.round(hz / hiHz));
    const maL = movAvg(v, wLong);
    const maS = movAvg(v, wShort);
    return v.map((x, i) => maS[i] - maL[i]);
  }

  function movAvg(v, w) {
    const out = new Array(v.length);
    const half = Math.floor(w / 2);
    for (let i = 0; i < v.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(v.length - 1, i + half); j++) {
        s += v[j]; c++;
      }
      out[i] = s / c;
    }
    return out;
  }

  /* ── main analysis ───────────────────────────────────────── */
  function analyse() {
    const now = performance.now();
    const winStart = now - WINDOW_SEC * 1000;
    const chunk = samples.filter(s => s.t >= winStart);
    if (chunk.length < MIN_WARMUP_SEC * RESAMPLE_HZ) return null;

    const { vals, dt } = resample(chunk, RESAMPLE_HZ);
    if (vals.length < MIN_WARMUP_SEC * RESAMPLE_HZ / 2) return null;
    const hz = RESAMPLE_HZ;

    /* ── heart rate via DFT ── */
    let det = detrend(vals, Math.round(hz * 0.8));
    det = normalise(det);
    const hrFreqs = [];
    for (let f = 0.75; f <= 3.5; f += 0.015) hrFreqs.push(f);
    const hrMags = dftMagnitudes(det, hrFreqs, hz);
    const hrPeak = findPeak(hrFreqs, hrMags, 0.75, 3.5);
    const bpm = hrPeak.freq > 0 ? Math.round(hrPeak.freq * 60) : null;

    /* confidence: peak / mean of band */
    let magSum = 0, magCnt = 0;
    for (let i = 0; i < hrFreqs.length; i++) {
      if (hrFreqs[i] >= 0.75 && hrFreqs[i] <= 3.5) { magSum += hrMags[i]; magCnt++; }
    }
    const meanMag = magCnt > 0 ? magSum / magCnt : 0;
    const snr = meanMag > 0 ? hrPeak.mag / meanMag : 0;
    const confidence = Math.min(1, Math.max(0, (snr - 1.2) / 3.8));

    /* ── HRV: RMSSD from time-domain peak detection ── */
    const bpFiltered = bandpass(det, hz, 0.7, 3.5);
    const minGapFrames = Math.round(hz * 0.28); /* min 280 ms between beats */
    const peaks = detectPeaks(bpFiltered, minGapFrames);
    const rmssd = computeRMSSD(peaks, hz);

    /* ── breathing rate via DFT ── */
    const brFreqs = [];
    for (let f = 0.12; f <= 0.60; f += 0.008) brFreqs.push(f);
    const brDet = detrend(vals, Math.round(hz * 2.5));
    const brMags = dftMagnitudes(brDet, brFreqs, hz);
    const brPeak = findPeak(brFreqs, brMags, 0.12, 0.60);
    const breathPerMin = brPeak.freq > 0 ? Math.round(brPeak.freq * 60) : null;

    /* ── stress index from HRV (0=calm, 100=stressed) ── */
    let stressPct = null;
    if (rmssd != null) {
      /* Empirical mapping: RMSSD ~20ms → high stress, ~120ms → low stress */
      stressPct = Math.round(Math.max(0, Math.min(100,
        100 - ((rmssd - 20) / 100) * 100
      )));
    }

    return { bpm, confidence, rmssd, breathPerMin, stressPct, peaks: peaks.length };
  }

  /* ── public: called per detection tick ───────────────────── */
  function processFrame(fBox) {
    if (fBox) faceBox = { x: fBox.x, y: fBox.y, width: fBox.width, height: fBox.height };
    const now = performance.now();
    if (now - lastAnalyseMs > ANALYSE_GAP && samples.length >= MIN_WARMUP_SEC * RESAMPLE_HZ) {
      latestVitals = analyse();
      lastAnalyseMs = now;
    }
  }

  function getVitals() {
    return latestVitals;
  }

  function isReady() {
    return latestVitals !== null && latestVitals.bpm !== null;
  }

  /* ── raw waveform for visualiser (last 5 s of green signal) ── */
  function getSignal() {
    const now = performance.now();
    return samples.filter(s => s.t >= now - 5000).map(s => ({ t: s.t, g: s.g }));
  }

  return { start, stop, processFrame, getVitals, isReady, getSignal, _samples: samples };
})();
