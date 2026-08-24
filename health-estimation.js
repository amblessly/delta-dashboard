"use strict";

window.HealthEstimation = (function () {

  function hashDescriptor(desc) {
    let h = 0;
    const arr = desc instanceof Float32Array ? desc : Array.from(desc);
    for (let i = 0; i < arr.length; i++) {
      h = ((h << 5) - h + Math.round(arr[i] * 10000)) | 0;
    }
    return Math.abs(h);
  }

  function seededRandom(seed) {
    let s = seed;
    return function () {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  function estimateFromFace(faceData) {
    const seed = hashDescriptor(faceData.descriptor);
    const rng = seededRandom(seed);
    const pts = faceData.landmarks.positions;

    const jawW = dist(pts[0], pts[16]);
    const eyeSpan = dist(pts[36], pts[45]);
    const noseLen = dist(pts[27], pts[30]);
    const mouthW = dist(pts[48], pts[54]);
    const faceH = dist(pts[8], pts[20]);
    const faceW = dist(pts[1], pts[15]);
    const eyeH_L = dist(pts[37], pts[41]);
    const eyeH_R = dist(pts[43], pts[47]);
    const browH = dist(pts[19], pts[37]);
    const faceRatio = faceW > 0 ? faceH / faceW : 1;
    const mouthNoseRatio = noseLen > 0 ? mouthW / noseLen : 1;
    const eyeSym = eyeH_L > 0 ? Math.abs(eyeH_L - eyeH_R) / eyeH_L : 0;

    const ageBase = clamp(18 + (faceRatio - 1.0) * 15 + (mouthNoseRatio - 1.0) * 8 + (eyeSpan / faceW - 0.45) * 20, 16, 75);
    const age = Math.round(ageBase + (rng() - 0.5) * 6);
    const ageClamped = clamp(age, 16, 80);
    const ageRange = ageClamped <= 22 ? "18-22" : ageClamped <= 30 ? "23-30" : ageClamped <= 45 ? "31-45" : ageClamped <= 60 ? "46-60" : "60+";

    const weightBase = 52 + (jawW / 100) * 12 + (faceW / 80) * 8;
    const weight = Math.round(weightBase + (rng() - 0.5) * 8);
    const weightClamped = clamp(weight, 42, 110);

    const tempBase = 36.4 + (ageClamped > 50 ? 0.2 : 0) + (faceRatio - 1.0) * 0.3;
    const temperature = Number((tempBase + (rng() - 0.5) * 0.6).toFixed(1));
    const tempClamped = clamp(temperature, 36.0, 37.8);

    const hydrationBase = 70 + (eyeSym * -40) + (faceRatio - 1.0) * 10;
    const hydration = Math.round(clamp(hydrationBase + (rng() - 0.5) * 15, 38, 95));

    const stressBase = 30 + (eyeSym * 60) + ((1 - browH / faceH) * 20);
    const stress = Math.round(clamp(stressBase + (rng() - 0.5) * 20, 8, 92));

    const electrolytesBase = 65 + (mouthNoseRatio - 1.0) * 10;
    const electrolytes = Math.round(clamp(electrolytesBase + (rng() - 0.5) * 15, 45, 90));

    const sodiumBase = 136 + (ageClamped - 18) * 0.08;
    const sodium = Math.round(clamp(sodiumBase + (rng() - 0.5) * 8, 130, 148));

    const lactateBase = 1.2 + (stress / 100) * 1.8 + (faceW < 120 ? 0.3 : 0);
    const lactate = Number(clamp(lactateBase + (rng() - 0.5) * 0.8, 0.6, 4.5).toFixed(1));

    return {
      age: ageClamped, ageRange, weight: weightClamped,
      temperature: tempClamped, hydration, stress, electrolytes, sodium, lactate,
      seed,
    };
  }

  function getStatus(metric, value) {
    const rules = {
      electrolytes: v => v >= 60 ? { key: "good", label: "GOOD" } : v >= 45 ? { key: "low", label: "LOW" } : { key: "critical", label: "CRITICAL" },
      hydration:    v => v >= 65 ? { key: "good", label: "GOOD" } : v >= 50 ? { key: "low", label: "LOW" } : { key: "critical", label: "CRITICAL" },
      stress:       v => v < 35 ? { key: "normal", label: "LOW" } : v < 55 ? { key: "slight", label: "MODERATE" } : v < 75 ? { key: "high", label: "HIGH" } : { key: "critical", label: "CRITICAL" },
      sodium:       v => v >= 135 && v <= 145 ? { key: "normal", label: "NORMAL" } : v >= 130 && v <= 150 ? { key: "elevated", label: "ELEVATED" } : { key: "critical", label: "CRITICAL" },
      lactate:      v => v < 2.0 ? { key: "normal", label: "NORMAL" } : v < 4.0 ? { key: "elevated", label: "ELEVATED" } : { key: "critical", label: "CRITICAL" },
      temperature:  v => v < 37.0 ? { key: "normal", label: "NORMAL" } : v < 37.8 ? { key: "slight", label: "SLIGHT" } : { key: "critical", label: "CRITICAL" },
    };
    return (rules[metric] || (() => ({ key: "normal", label: "NORMAL" })))(value);
  }

  function generateRecommendations(result) {
    const recs = [];
    if (result.hydration < 55) recs.push({ id: "hydration", icon: "cyan", theme: "amber", title: "Drink 500 ml water soon", desc: `Hydration at <b>${result.hydration}%</b> - encourage adequate fluid intake and monitor for heat illness symptoms.` });
    else if (result.hydration >= 75) recs.push({ id: "hydration", icon: "cyan", theme: "green", title: "Hydration looks good", desc: `Hydration at <b>${result.hydration}%</b> - maintain regular water intake and take short breaks if needed.` });
    if (result.stress >= 65) recs.push({ id: "stress", icon: "purple", theme: "red", title: "5-min breathing exercise", desc: `Stress at <b>${result.stress}%</b> - reduce activity, rest in a cooler area, monitor for dizziness or nausea.` });
    else if (result.stress >= 40) recs.push({ id: "stress", icon: "purple", theme: "amber", title: "Consider a short break", desc: `Stress at <b>${result.stress}%</b> - mild elevation detected. A brief rest may help.` });
    if (result.lactate >= 3.0) recs.push({ id: "lactate", icon: "amber", theme: "amber", title: "Lactate elevated", desc: `Lactate at <b>${result.lactate} mmol/L</b> - tone down activity and reassess after adequate recovery.` });
    if (result.electrolytes < 55) recs.push({ id: "electrolytes", icon: "green", theme: "amber", title: "Electrolyte balance trending down", desc: `Electrolytes <b>${result.electrolytes}%</b> - an isotonic drink will restore balance.` });
    if (recs.length === 0) recs.push({ id: "hydration", icon: "cyan", theme: "green", title: "All indicators normal", desc: "Health estimates appear within normal ranges. Maintain current activity level and hydration." });
    return recs.slice(0, 3);
  }

  function buildResult(faceData) {
    const raw = estimateFromFace(faceData);
    return {
      age: raw.age, ageRange: raw.ageRange, weight: raw.weight,
      metrics: {
        electrolytes: { value: raw.electrolytes, unit: "%", status: getStatus("electrolytes", raw.electrolytes) },
        hydration:    { value: raw.hydration, unit: "%", status: getStatus("hydration", raw.hydration) },
        stress:       { value: raw.stress, unit: "%", status: getStatus("stress", raw.stress) },
        sodium:       { value: raw.sodium, unit: "mEq/L", status: getStatus("sodium", raw.sodium) },
        lactate:      { value: raw.lactate, unit: "mmol/L", status: getStatus("lactate", raw.lactate) },
        temperature:  { value: raw.temperature, unit: "\u00B0C", status: getStatus("temperature", raw.temperature) },
      },
      recommendations: generateRecommendations(raw),
      seed: raw.seed,
    };
  }

  return { buildResult, getStatus };
})();
