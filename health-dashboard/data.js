/* ===
   data.js - Dashboard data layer (hardware-independent)

   The UI only talks to a `DataSource` object exposing:
     start(onUpdate)  -> begins streaming snapshots
     stop()           -> halts streaming
     sendCommand(cmd) -> optional operator commands

   Each snapshot has the shape:
   {
     link: "OK" | "ACQUIRING",
     student: { name, age, weightKg },
     overall: { key, label },
     metrics: {
       electrolytes: { value, unit:"%",  status },
       hydration:    { value, unit:"%",  status },
       stress:       { value, unit:"%",  status },
       sodium:       { value, unit:"mEq/L",  status },
       lactate:      { value, unit:"mmol/L", status },
       temperature:  { value, unit:"--C", status }
     },
     heatStress: { pct, level, label, inputs:{T,E,L} },
     ph: { value, zone:{ id, name, range, meaning, action } },
     assessment: { key:"ok"|"verify"|"critical", title, text },
     recommendations: [ { id, icon, title, desc(html) } ]
   }

   For real deployment on the Raspberry Pi, replace
   `createSimulatedDataSource()` with e.g.
   `createPollingDataSource("/api/vitals")` that fetches the same
   snapshot JSON from the Python backend. Nothing else changes.
   === */

"use strict";

/* === Status rules === */

const STATUS_RULES = {
  electrolytes: v =>
    v >= 60 ? { key: "good",     label: "GOOD" }     :
    v >= 45 ? { key: "low",      label: "LOW" }      :
              { key: "critical", label: "CRITICAL" },

  hydration: v =>
    v >= 65 ? { key: "good",     label: "GOOD" }     :
    v >= 50 ? { key: "low",      label: "LOW" }      :
              { key: "critical", label: "CRITICAL" },

  stress: v =>
    v < 55 ? { key: "normal",   label: "NORMAL" }   :
    v < 75 ? { key: "slight",   label: "SLIGHT" }   :
    v < 90 ? { key: "high",     label: "HIGH" }     :
             { key: "critical", label: "CRITICAL" },

  sodium: v =>
    v >= 135 && v <= 145 ? { key: "normal",   label: "NORMAL" } :
    v >= 130 && v <= 150 ? { key: "elevated", label: "ELEVATED" } :
                           { key: "critical", label: "CRITICAL" },

  lactate: v =>
    v < 2.0 ? { key: "normal",   label: "NORMAL" }   :
    v < 4.0 ? { key: "elevated", label: "ELEVATED" } :
              { key: "critical", label: "CRITICAL" },

  temperature: v =>
    v < 37.0 ? { key: "normal",   label: "NORMAL" } :
    v < 37.8 ? { key: "slight",   label: "SLIGHT" } :
               { key: "critical", label: "CRITICAL" },
};

const OVERALL_RULE = metrics => {
  const bad = ["critical"].includes(metrics.hydration.status.key) ||
              ["critical"].includes(metrics.stress.status.key);
  const warn = ["low", "high", "slight", "elevated"]
    .includes(metrics.hydration.status.key) ||
    ["high", "slight", "elevated"].includes(metrics.stress.status.key) ||
    ["slight", "elevated"].includes(metrics.lactate.status.key);
  if (bad)  return { key: "bad",  label: "ATTENTION" };
  if (warn) return { key: "warn", label: "MONITORED" };
  return { key: "ok", label: "STABLE" };
};

/* === Heat Stress engine (per project spec) ===
   Heat Stress % = (0.55 x T) + (0.25 x ELEC) + (0.20 x LAC)

   How each raw sensor reading is normalized to a 0-100 scale:
   - T    : temperature, linear map over the physiological risk band.
            36.5C = thermoneutral baseline (0%), 39.5C = heat-illness
            emergency threshold (100%). T_norm = ((T - 36.5) / 3.0) * 100
   - ELEC : sweat electrolyte index. The dashboard already expresses it on
            a 0-100% scale aligned with the spec bands (<33 low, 34-66
            moderate, >=67 high sodium-loss risk), so it is used directly.
   - LAC  : lactate, linear map over the clinical range.
            1.0 mmol/L = resting (0%), 5.0 mmol/L = severe buildup (100%).
            LAC_norm = ((LAC - 1.0) / 4.0) * 100

   Classification bands (same as hydration-risk scale in the spec):
   <=33 LOW | 34-66 MODERATE | >=67 HIGH */
const clamp100 = v => Math.min(100, Math.max(0, v));
const normTemp = t => clamp100(((t - 36.5) / 3.0) * 100);
const normLac = l => clamp100(((l - 1.0) / 4.0) * 100);

function computeHeatStress(m) {
  const inputs = {
    T: Math.round(normTemp(m.temperature.value)),
    E: Math.round(clamp100(m.electrolytes.value)),
    L: Math.round(normLac(m.lactate.value)),
  };
  const pct = Math.round((0.55 * inputs.T + 0.25 * inputs.E + 0.20 * inputs.L) * 10) / 10;
  const level = pct <= 33 ? "low" : pct <= 66 ? "moderate" : "high";
  const label = level === "low" ? "LOW" : level === "moderate" ? "MODERATE" : "HIGH";
  return { pct, level, label, inputs };
}

/* === Sweat pH strip zones (per project spec) === */
const PH_ZONES = [
  { id: "blue",         min: 5.4, max: 99,   name: "BLUE",          range: "pH >= 5.4" },
  { id: "greenzone",    min: 4.6, max: 5.39, name: "GREEN",         range: "pH 4.6-5.3" },
  { id: "yellowgreen",  min: 3.9, max: 4.59, name: "YELLOW-GREEN",  range: "pH 3.9-4.5" },
  { id: "brightyellow", min: 0,   max: 3.89, name: "BRIGHT YELLOW", range: "pH <= 3.8" },
];
function phZone(ph) {  return PH_ZONES.find(z => ph >= z.min && ph <= z.max) || PH_ZONES[3];
}

/* Zone interpretation + recommended response, wording per source document:
   - BLUE           >= 5.4 : default or normal, resting sweat -> plain water
                             may generally be sufficient.
   - GREEN        4.6-5.3 : mild exertion, moderate lactate buildup (<2 mmol/L),
                             low sweat sodium loss (<30 mEq/L).
   - YELLOW-GREEN 3.9-4.5 : heavy exertion, moderately high lactate (~2 mmol/L),
                             moderate sweat sodium loss (30-60 mEq/L). Needs
                             attention, rest, hydration, or reassessment.
   - BRIGHT YELLOW  <= 3.8 : extreme physical exhaustion, high lactate buildup
                             (>2 mmol/L), high sweat sodium loss (>60 mEq/L).
                             Requires immediate cessation of activity and
                             medical assessment. */
const ZONE_GUIDANCE = {
  blue: {
    meaning: "Default or normal - resting sweat",
    action:  "Plain water may generally be sufficient.",
  },
  greenzone: {
    meaning: "Mild exertion - lactate <2 mmol/L, sodium loss <30 mEq/L",
    action:  "Temporarily reduce activity, move to a cooler shaded area, drink fluids gradually, continue monitoring.",
  },
  yellowgreen: {
    meaning: "Heavy exertion - lactate ~2 mmol/L, sodium loss 30-60 mEq/L",
    action:  "Stop or reduce the activity, rest in a cooler ventilated area, drink fluids gradually, monitor symptoms.",
  },
  brightyellow: {
    meaning: "Extreme exhaustion - lactate >2 mmol/L, sodium loss >60 mEq/L",
    action:  "Stop activity immediately and move to a cooler environment. Seek medical assessment if symptoms do not improve or worsen.",
  },
};

/* Measurement verification logic (per source document): abnormal readings are
   a signal for verification, not a diagnosis. The nurse/coach should reassess
   the athlete, repeat the measurement if necessary, check for possible device
   error, and observe for developing symptoms. */
function buildAssessment(ph, metrics, heatStress) {
  const abnormal = Object.values(metrics)
    .filter(m => !["good", "normal"].includes(m.status.key));

  if (ph.zone.id === "brightyellow" || heatStress.level === "high") {
    return {
      key: "critical",
      title: "STOP ACTIVITY - SEEK ASSESSMENT",
      text: `${ph.zone.action} The athlete may not be ready to return to activity until indicators improve.`,
    };
  }
  if (ph.zone.id !== "blue") {
    return {
      key: "verify",
      title: "NEEDS REASSESSMENT",
      text: `${ph.zone.action} Treat the reading as a signal for verification: reassess the athlete and check for possible device error.`,
    };
  }
  if (abnormal.length > 0) {
    return {
      key: "verify",
      title: "MONITOR",
      text: "Reassess the athlete's overall condition - sweat pH alone is not sufficient to determine physiological stress. Encourage fluid intake and continue assessment if readings stay abnormal or marked symptoms occur.",
    };
  }
  return {
    key: "ok",
    title: "ROUTINE MONITORING",
    text: "Can continue the activity with routine monitoring. Record the pH result and interpret it together with other hydration indicators rather than color alone.",
  };
}

/* === Recommendation templates === */

const REC_LIBRARY = {
  hydration: {
    id: "hydration",
    icon: "cyan",
    theme: "amber",
    title: "Drink 500 ml water soon",
    make: m => `Hydration at <b>${fmt(m.hydration.value)}%</b> - encourage adequate fluid intake and monitor for heat illness symptoms.`,
  },
  stress: {
    id: "stress",
    icon: "purple",
    theme: "red",
    title: "5-min breathing exercise",
    make: m => `Stress at <b>${fmt(m.stress.value)}%</b> - reduce activity, rest in a cooler area, monitor for dizziness or nausea.`,
  },
  lactate: {
    id: "lactate",
    icon: "amber",
    theme: "amber",
    title: "Lactate elevated",
    make: m => `Lactate at <b>${fmt(m.lactate.value, 1)} mmol/L</b> - tone down activity and reassess after adequate recovery.`,
  },
  electrolytes: {
    id: "electrolytes",
    icon: "green",
    title: "Electrolyte balance trending down",
    make: m => `Electrolytes <b>${fmt(m.electrolytes.value)}%</b> - an isotonic drink will restore balance.`,
  },
};

function fmt(v, dec = 0) {
  return Number(v).toFixed(dec);
}

/* - Simulated data source - */

/* Default student placeholder when no user is detected */
const DEFAULT_STUDENT = {
  name: "--",
  age: "--",
  weightKg: "--",
};

function createSimulatedDataSource() {
  /* Baseline readings (reference values).
     A new face-detection session always restarts from these values -
     each scan is a fresh measurement. */
  const BASELINES = {
    electrolytes: 72.0,
    hydration:    54.0,
    stress:       75.0,
    sodium:       138.0,
    lactate:      2.4,
    temperature:  37.1,
  };
  const PH_BASELINE = 6.1;

  // Random-walk state anchored around the reference values.
  const state = {
    electrolytes: { value: BASELINES.electrolytes, min: 58, max: 88, step: 0.9 },
    hydration:    { value: BASELINES.hydration,    min: 44, max: 70, step: 0.5 },
    stress:       { value: BASELINES.stress,       min: 52, max: 92, step: 0.8 },
    sodium:       { value: BASELINES.sodium,       min: 133, max: 144, step: 0.7 },
    lactate:      { value: BASELINES.lactate,      min: 1.4, max: 3.6, step: 0.06 },
    temperature:  { value: BASELINES.temperature,  min: 36.6, max: 37.9, step: 0.03 },
  };

  let timer = null;
  let paused = false;
  let phValue = PH_BASELINE;
  let activeStudent = null;

  /* Biometric gate: values are only shown while a face is detected
     by the camera monitor (main.js wires FaceMonitor -> setPresence).
     While absent, every metric reads 0 / STANDBY. */
  let presence = false;

  const listeners = [];

  /* ── Device pH integration (colorimetric strip pipeline) ──────────
     The strip device pushes validated measurements via
     pushStripMeasurement(). While a measurement is fresh (< TTL) it
     drives the dashboard pH; afterwards the source falls back to the
     simulated walk and labels itself SIMULATED again. Vitals remain
     simulated until real sensor hardware exists - never presented as
     live hardware data. */
  const DEVICE_PH_TTL = 120000;
  let devicePH = null;

  function pushStripMeasurement(m) {
    if (!m || typeof m !== "object") return false;
    const ph = Number(m.ph);
    if (!Number.isFinite(ph) || ph < 0 || ph > 14) {
      console.warn("[DashboardData] Rejected invalid strip measurement: bad pH");
      return false;
    }
    const rgb = m.rgb || null;
    if (rgb && !(Number.isFinite(rgb.r) && Number.isFinite(rgb.g) && Number.isFinite(rgb.b))) {
      console.warn("[DashboardData] Rejected invalid strip measurement: bad RGB");
      return false;
    }
    let confidence = null;
    if (m.confidence != null) {
      confidence = Number(m.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
        console.warn("[DashboardData] Rejected invalid strip measurement: bad confidence");
        return false;
      }
    }
    devicePH = {
      value: Math.round(ph * 100) / 100,
      rgb,
      confidence,
      method: typeof m.method === "string" ? m.method : "DEVICE",
      received: Date.now(),
    };
    if (!paused && timer) emit();
    return true;
  }

  function stripSourceInfo() {
    const fresh = devicePH && Date.now() - devicePH.received < DEVICE_PH_TTL;
    if (fresh) {
      return { value: devicePH.value, source: "DEVICE", method: devicePH.method,
               confidence: devicePH.confidence, rgb: devicePH.rgb };
    }
    if (devicePH && !fresh) devicePH = null; /* expired */
    return { value: null, source: "SIMULATED", method: "RANDOM_WALK",
             confidence: null, rgb: null };
  }

  function tick() {
    if (paused) return;
    for (const k of Object.keys(state)) {
      const s = state[k];
      // gentle pull toward mid-range + noise --- organic drift
      const pull = ((s.min + s.max) / 2 - s.value) * 0.02;
      const noise = (Math.random() - 0.5) * 2 * s.step;
      s.value = Math.min(s.max, Math.max(s.min, s.value + pull + noise));
    }
    /* Sweat pH tracks exertion: resting sweat sits ~6.5+ (blue zone);
       as stress and lactate climb it drops toward the bright-yellow band.
       Smoothed random walk so the strip color changes organically. */
    const intensity =
      (state.stress.value / 100 + normLac(state.lactate.value) / 100) / 2;
    const targetPh = 6.7 - intensity * 3.0;
    phValue += (targetPh - phValue) * 0.15 + (Math.random() - 0.5) * 0.06;
    phValue = Math.min(7.1, Math.max(3.4, phValue));
    emit();
  }

  function buildSnapshot() {
    /* NO SIGNAL mode: no face detected -> everything reads zero. */
    if (!presence) {
      const metrics = {};
      for (const k of Object.keys(state)) {
        metrics[k] = {
          value: 0,
          unit: UNIT_BY_KEY[k],
          status: { key: "standby", label: "STANDBY" },
        };
      }
      const zzone = phZone(0);
      return {
        link: "STANDBY",
        overall: { key: "standby", label: "NO SIGNAL" },
        student: activeStudent || DEFAULT_STUDENT,
        heatStress: { pct: 0, level: "low", label: "STANDBY", inputs: { T: 0, E: 0, L: 0 } },
        ph: {
          value: 0,
          zone: { ...zzone, ...ZONE_GUIDANCE[zzone.id] },
          source: "SIMULATED", method: null, confidence: null, rgb: null,
        },
        metrics,
        assessment: null,
        recommendations: [],
        presence,
      };
    }

    const metrics = {};
    for (const k of Object.keys(state)) {
      metrics[k] = {
        value: state[k].value,
        unit: UNIT_BY_KEY[k],
        status: STATUS_RULES[k](state[k].value),
      };
    }
    metrics.sodium.value = Math.round(state.sodium.value);
    metrics.electrolytes.value = Math.round(state.electrolytes.value);
    metrics.hydration.value = Math.round(state.hydration.value);
    metrics.stress.value = Math.round(state.stress.value);

    const src = stripSourceInfo();
    if (src.source === "SIMULATED") {
      /* No fresh device reading - continue the simulated walk. */
      phValue = Math.min(7.1, Math.max(3.4, phValue));
    }
    const effectivePh = src.source === "DEVICE" ? src.value : phValue;
    const zone = phZone(effectivePh);
    const ph = {
      value: Math.round(effectivePh * 10) / 10,
      zone: { ...zone, ...ZONE_GUIDANCE[zone.id] },
      source: src.source,
      method: src.method,
      confidence: src.confidence,
      rgb: src.rgb,
    };
    const heatStress = computeHeatStress(metrics);

    return {
      link: "OK",
      overall: OVERALL_RULE(metrics),
      student: activeStudent || DEFAULT_STUDENT,
      heatStress,
      ph,
      metrics,
      assessment: buildAssessment(ph, metrics, heatStress),
      recommendations: pickRecommendations(metrics),
      presence,
    };
  }

  function pickRecommendations(m) {
    const picks = [];
    if (m.hydration.status.key !== "good")        picks.push(REC_LIBRARY.hydration);
    if (m.stress.status.key === "high" ||
        m.stress.status.key === "critical")       picks.push(REC_LIBRARY.stress);
    if (m.lactate.status.key !== "normal")        picks.push(REC_LIBRARY.lactate);
    if (m.electrolytes.status.key !== "good")     picks.push(REC_LIBRARY.electrolytes);
    if (picks.length === 0) picks.push(REC_LIBRARY.electrolytes);

    return picks.slice(0, 3).map(t => ({
      id: t.id,
      icon: t.icon,
      theme: t.theme,
      title: t.title,
      desc: t.make(metricsWithRounding(m)),
    }));
  }

  function metricsWithRounding(m) {
    return {
      ...m,
      lactate: { ...m.lactate, value: Number(fmt(m.lactate.value, 1)) },
    };
  }

  const UNIT_BY_KEY = {
    electrolytes: "%",
    hydration: "%",
    stress: "%",
    sodium: "mEq/L",
    lactate: "mmol/L",
    temperature: "\u00B0C",
  };

  function emit() {
    const snap = buildSnapshot();
    listeners.forEach(fn => fn(snap));
  }

  return {
    start(onUpdate) {
      /* Event-driven: snapshots emit on start, presence change, and
         operator commands - no automatic random-walk timer. */
      listeners.push(onUpdate);
      emit();
      return true;
    },
    stop() {
      clearInterval(timer);
      timer = null;
      listeners.length = 0;
    },
    setPaused(p) {
      paused = p;
      if (!p) emit();
    },
    /* Biometric gate (wired to FaceMonitor by main.js). */
    setPresence(p) {
      p = !!p;
      if (p === presence) return;
      presence = p;
      /* New detection session -> fresh baseline readings. */
      if (p) {
        for (const k of Object.keys(BASELINES)) state[k].value = BASELINES[k];
        phValue = PH_BASELINE;
      }
      emit();
    },

    /* Bind dashboard readings to a specific student identity
       ({id,name,age,weightKg}) coming from facial recognition. */
    setStudent(s) {
      activeStudent = s || null;
      presence = !!activeStudent;
      if (presence) {
        /* Derive personalized baseline from student characteristics */
        const ageNum = Number(activeStudent.age) || 18;
        const weightNum = Number(activeStudent.weightKg) || 55;
        state.temperature.value = Number((36.8 + ((weightNum % 5) * 0.1)).toFixed(1));
        state.hydration.value = Math.min(68, Math.max(45, Math.round(52 + (weightNum % 10))));
        state.electrolytes.value = Math.min(85, Math.max(60, Math.round(70 + ((ageNum % 4) * 2))));
        state.stress.value = Math.min(88, Math.max(55, Math.round(68 + ((weightNum % 7) * 3))));
        state.sodium.value = Math.round(136 + ((ageNum + weightNum) % 6));
        state.lactate.value = Number((1.8 + ((weightNum % 4) * 0.4)).toFixed(1));
        phValue = Number((6.3 - ((state.stress.value - 50) / 100)).toFixed(1));
      }
      emit();
    },
    getPresence() { return presence; },
    /* Feed a validated colorimetric strip measurement (device.js). */
    pushStripMeasurement,
    /* Operator commands (acknowledge recommendation nudges the sim). */
    sendCommand(cmd) {
      if (cmd.type === "hydrate") {
        state.hydration.value = Math.min(state.hydration.max, state.hydration.value + 6);
        state.electrolytes.value = Math.min(state.electrolytes.max, state.electrolytes.value + 3);
        tick();
      }
      if (cmd.type === "breathe") {
        state.stress.value = Math.max(state.stress.min, state.stress.value - 8);
        tick();
      }
    },
  };
}

/* Exposed factories so main.js stays source-agnostic.
   createDeviceDataSource is the same pipeline, integrated with the
   colorimetric strip device: call src.pushStripMeasurement({...}) to
   feed real readings. Vitals remain simulated until real sensors exist. */
window.DashboardData = {
  createSimulatedDataSource,
  createDeviceDataSource: createSimulatedDataSource,
  PH_ZONES,
  phZone,
};

